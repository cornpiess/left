import { AppState, Platform } from 'react-native';
import * as MediaLibrary from 'expo-media-library/legacy';
import { Asset } from 'expo-media-library/next';
import * as FileSystem from 'expo-file-system/legacy';
import * as Network from 'expo-network';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { assignBursts, buildBurstUnits } from './burst';
import { getAlgorithmConfig } from './algorithmConfig.mjs';
import { mergeContiguousBucketSample, pickBucketAnchor, planSpreadBuckets } from './sampling.mjs';
import { shuffle } from './picker';
import { createReloadCoalescer, mapLimit } from './asyncUtils.mjs';
import { createTrashDeletion } from './trashDeletion.mjs';
import { supportsNativePhotoPreview, addNativeBurstMetadata, deleteAssetsWithSystemConfirmation, fetchNativeBurstMembers, accessibleNativeAssetIds } from './nativePhotoPreview';
import { reviewStore } from './reviewStore.js';
import { createBrowseSession } from './browseSession.mjs';
import { RecentIds } from './reviewStore.mjs';
import { createCandidatePager } from './candidatePager.mjs';
import { createDayPager } from './dayPager.mjs';
import { createResourceScheduler } from './resourceScheduler.mjs';
import { flightEvent } from './flightRecorder';
import { getLocalDayKey, getPhotoKitAssetRef, getPhotoKitPreviewUri, getRenderableDisplayUri, getRenderableImageUri, sortAndShuffleByStorageImpact } from './mediaPage.mjs';

const USE_MOCK = Platform.OS !== 'ios';
const MEMORY_COUNT = 30;
const INITIAL_SAMPLE_SIZE = getAlgorithmConfig().initialSampleSize;
const RESOLVE_BATCH_SIZE = 5;
const CLOUD_DOWNLOAD_CONCURRENCY = 2;
const CLOUD_RETRY_LIMIT = 2;
const FEED_CACHE_FILE = FileSystem.documentDirectory ? `${FileSystem.documentDirectory}vibe-feed-cache.json` : null;
const SANDBOX_MEDIA_DIR = FileSystem.cacheDirectory ? `${FileSystem.cacheDirectory}vibe-media/` : null;

// ---- LRU Map Cache for Memory Protection ----
class LRUMap {
  constructor(capacity = 50) {
    this.capacity = capacity;
    this.map = new Map();
  }
  get(key) {
    if (!this.map.has(key)) return undefined;
    const val = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, val);
    return val;
  }
  set(key, val) {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.capacity) {
      const oldestKey = this.map.keys().next().value;
      this.map.delete(oldestKey);
    }
    this.map.set(key, val);
  }
  has(key) {
    return this.map.has(key);
  }
  delete(key) {
    return this.map.delete(key);
  }
  clear() {
    this.map.clear();
  }
  /** Iterate [key, value] pairs in recency order (oldest first). */
  entries() {
    return this.map.entries();
  }
}

// ---- iOS: in-memory cache + trash set ----
let cachedAssets = [];
const trashIds = new Set();
let memorySession = null;
let browsing = createBrowseSession();
let browseOpening = null;
let browseGeneration = 0;
let pageRequest = null;
let recoveryRequest = null;
let libraryRevision = 0;
let mockBrowseSnapshot = null;
export function getBrowseSession() { return browsing; }
async function photoLoadStage(stage, work) {
  try { return await work(); }
  catch (cause) {
    if (cause?.photoLoadStage) throw cause;
    const error = new Error(cause?.message || String(cause));
    error.photoLoadStage = stage;
    error.code = cause?.code;
    error.cause = cause;
    flightEvent('photo-load-failed', { stage, code: error.code, message: error.message });
    throw error;
  }
}
export async function persistBrowseSession() {
  // Resume progress is recoverable metadata. Failure here must not hide photos
  // that have already been read. Cleanup's atomic checkpoint remains strict.
  try {
    const snapshot = browsing.snapshot({ blocked: USE_MOCK ? mockTrashIds : trashIds });
    if (USE_MOCK) { mockBrowseSnapshot = snapshot; return true; }
    return await reviewStore.saveBrowse(snapshot);
  } catch (error) { flightEvent('browse-save-failed', error?.message || 'unknown'); return false; }
}
export function retryBrowseSession() {
  if (recoveryRequest) return recoveryRequest;
  const task = (async () => {
    if (!USE_MOCK) await photoLoadStage('permission', async () => {
      const permission = await MediaLibrary.getPermissionsAsync(false, ['photo']);
      if (!permission.granted) throw Error('Photo library access is not granted');
    });
    const owner = await openBrowseSession();
    // Restart only the transient source/pager, not reviews, pending items,
    // quota, rhythm or the active anchor. Old work cannot replace this source.
    libraryRevision++;
    memorySession = null;
    pageRequest = null;
    flightEvent('photo-load-retry', { revision: libraryRevision });
    return owner;
  })();
  recoveryRequest = task;
  return task.finally(() => { if (recoveryRequest === task) recoveryRequest = null; });
}
export async function resetBrowseSession() {
  browseGeneration++;
  browseOpening = null; memorySession = null; pageRequest = null;
  const epoch = USE_MOCK ? browsing.state.epoch + 1 : await reviewStore.resetBrowse();
  browsing = createBrowseSession({ epoch }); mockBrowseSnapshot = null;
  return browsing;
}

const viewedIds = new RecentIds(4096);
let reviewStatePromise = null;
let reviewedCount = 0;
export const mediaResources = createResourceScheduler({ concurrency: 3 });

async function ensureReviewState() {
  if (USE_MOCK) return;
  if (!reviewStatePromise) reviewStatePromise = reviewStore.load().then(state => {
    state.recent.forEach(id => viewedIds.add(id));
    state.trash.forEach(id => trashIds.add(id));
    reviewedCount = state.count;
    totalCleanedSizeBytes = state.bytes;
    void reconcilePendingDeletion().catch(error => flightEvent('delete-recovery', error?.message || 'deferred'));
  }).catch(error => { reviewStatePromise = null; throw error; });
  return reviewStatePromise;
}
async function primeReviewed(items) {
  await ensureReviewState();
  if (USE_MOCK) return new Set(items.filter(item => viewedIds.has(item.id)).map(item => item.id));
  const found = await reviewStore.reviewed(items.map(item => item.id));
  found.forEach(id => viewedIds.add(id));
  return found;
}

const cloudDownloadQueue = [];
const cloudDownloadIds = new Set();
const mediaUpdateListeners = new Set();
let cloudDownloadsActive = 0;

// ---- Network & iCloud Pre-cache Strategy State ----
let isWeakOrOfflineNetwork = false;
let lastNetworkCheckTime = 0;
let recentCloudFailures = 0;
let lastFailureReset = Date.now();

export async function checkNetworkCondition() {
  const now = Date.now();
  if (now - lastFailureReset > 30000) {
    recentCloudFailures = 0;
    lastFailureReset = now;
  }
  if (now - lastNetworkCheckTime < 4000) {
    return isWeakOrOfflineNetwork || recentCloudFailures >= 2;
  }
  lastNetworkCheckTime = now;
  try {
    const state = await Network.getNetworkStateAsync();
    const isOffline = !state.isConnected || state.isInternetReachable === false;
    const isCellular = state.type === Network.NetworkStateType.CELLULAR;
    isWeakOrOfflineNetwork = isOffline || isCellular;
  } catch {
    // Graceful fallback for web/mock
  }
  return isWeakOrOfflineNetwork || recentCloudFailures >= 2;
}

export function recordCloudFailure() {
  recentCloudFailures += 1;
}

export function isTrashAsset(id) {
  if (!id) return false;
  return USE_MOCK ? mockTrashIds.has(id) : trashIds.has(id);
}

// ---- Recommendation Mode (Default vs Storage Saver / Large File First) ----
const RECOMMEND_MODE_STORAGE_KEY = 'vibe-recommend-mode';
let currentRecommendMode = 'default';

export async function loadRecommendMode() {
  try {
    const saved = await AsyncStorage.getItem(RECOMMEND_MODE_STORAGE_KEY);
    currentRecommendMode = saved === 'storage' ? 'storage' : 'default';
  } catch {}
  return currentRecommendMode;
}

export function getRecommendMode() {
  return currentRecommendMode;
}

export async function setRecommendMode(mode) {
  if (mode !== 'default' && mode !== 'storage') return currentRecommendMode;
  currentRecommendMode = mode;
  try {
    await AsyncStorage.setItem(RECOMMEND_MODE_STORAGE_KEY, mode);
  } catch {}
  return currentRecommendMode;
}

// ---- Non-iOS mock data (Android / web / etc.) ----
let mockItems = null;
const mockTrashIds = new Set();
const mockFavIds = new Set();

const SAMPLE_VIDEOS = [
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4',
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4',
];

const MOCK_PLACES = [
  { latitude: 31.2304, longitude: 121.4737 }, // 上海
  { latitude: 39.9042, longitude: 116.4074 }, // 北京
  { latitude: 22.5431, longitude: 114.0579 }, // 深圳
  { latitude: 30.5728, longitude: 104.0668 }, // 成都
];

export async function flushViewedHistory() {
  if (!USE_MOCK) await reviewStore.flush();
}
if (!USE_MOCK) {
  AppState.addEventListener('change', state => {
    mediaResources.setSuspended(state !== 'active');
    if (state !== 'active') {
      void flushViewedHistory().catch(() => {});
      void persistBrowseSession().catch(error => flightEvent('browse-save', error?.message || 'failed'));
    }
  });
}
export async function loadViewedHistory() {
  await ensureReviewState();
  return viewedIds;
}
export async function loadTrashHistory() {
  await ensureReviewState();
  return trashIds;
}
let totalCleanedSizeBytes = 0;
export async function loadCleanedHistory() {
  await ensureReviewState();
  return totalCleanedSizeBytes;
}
export function getTotalCleanedBytes() { return totalCleanedSizeBytes; }
export function persistCleanedHistory() { return USE_MOCK ? Promise.resolve() : reviewStore.flush(); }
function flushTrashHistory() { return persistCleanedHistory(); }

// Compatibility read for the one-time legacy launch; never write a second progress cache.
export async function loadFeedCache() {
  if (!FEED_CACHE_FILE || USE_MOCK) return [];
  try {
    const value = JSON.parse(await FileSystem.readAsStringAsync(FEED_CACHE_FILE));
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}
export async function openBrowseSession() {
  if (browseOpening) return browseOpening;
  const generation = browseGeneration;
  const opening = (async () => {
    await photoLoadStage('review-store', ensureReviewState);
    await loadRecommendMode();
    const saved = USE_MOCK ? { snapshot: mockBrowseSnapshot } : await photoLoadStage('resume-store', () => reviewStore.loadBrowse());
    if (generation !== browseGeneration) return browsing;
    if (saved.invalid && !USE_MOCK) saved.epoch = await reviewStore.resetBrowse();
    if (generation !== browseGeneration) return browsing;
    browsing = createBrowseSession(saved);
    const owner = browsing;
    if (saved.snapshot) {
      // Resume context intentionally includes reviewed assets. Only pending/inaccessible IDs are excluded.
      const ids = owner.state.entries.flatMap(e => e.unit.items);
      const dayAnchor = owner.state.day?.items?.find(i => i.id === owner.state.day.anchorId);
      const anchor = dayAnchor || ids.find(i => i.id === owner.state.anchorId);
      const first = anchor ? [anchor] : ids.slice(0, 1);
      const checked = await photoLoadStage('resume-validation', () => filterAccessibleCachedMedia(first, { allowReviewed: true }));
      if (owner !== browsing) return browsing;
      const unavailable = new Set(first.filter(i => !checked.some(c => c.id === i.id)).map(i => i.id));
      owner.remove(unavailable);
      if (owner.state.day && unavailable.has(owner.state.day.anchorId)) {
        const day = owner.state.day, index = day.items.findIndex(i => i.id === day.anchorId);
        const next = day.items.slice(index + 1).find(i => !unavailable.has(i.id))
          || day.items.slice(0, index).reverse().find(i => !unavailable.has(i.id));
        day.items = day.items.filter(i => !unavailable.has(i.id)); day.anchorId = next?.id || null;
        if (!day.items.length) owner.leaveDay();
      }
      owner.restoreAnchor(USE_MOCK ? mockTrashIds : trashIds);
      // The rest is checked in bounded batches without delaying the restored first image.
      void (async () => {
        const remaining = [...ids, ...(owner.state.day?.items || [])].filter(i => !first.some(a => a.id === i.id));
        const accessible = await filterAccessibleCachedMedia(remaining, { allowReviewed: true });
        if (owner !== browsing) return;
        const allowed = new Set(accessible.map(i => i.id));
        owner.remove(new Set(remaining.filter(i => !allowed.has(i.id)).map(i => i.id)));
        if (owner.state.day) owner.state.day.items = owner.state.day.items.filter(i => allowed.has(i.id) || checked.some(a => a.id === i.id));
        mediaUpdateListeners.forEach(listener => listener({ type: 'browse-reconciled' }));
        await persistBrowseSession();
      })().catch(error => flightEvent('browse-validation', error?.message || 'retry'));
    } else {
      const legacy = await filterAccessibleCachedMedia(await loadFeedCache());
      if (owner !== browsing) return browsing;
      assignBursts(legacy); owner.ingest(buildBurstUnits(legacy));
    }
    return owner;
  })();
  const tracked = opening.catch(error => { if (browseOpening === tracked) browseOpening = null; throw error; });
  browseOpening = tracked;
  return tracked;
}

export async function reconcileBrowseLibrary() {
  const owner = browsing;
  const items = [...owner.state.entries, ...owner.state.candidates].flatMap(entry => entry.unit.items);
  const allowed = new Set((await filterAccessibleCachedMedia(items, { allowReviewed: true })).map(item => item.id));
  if (owner !== browsing) return;
  const absent = new Set(items.filter(item => !allowed.has(item.id)).map(item => item.id));
  owner.remove(absent); owner.pruneCandidates(absent);
  owner.restoreAnchor(USE_MOCK ? mockTrashIds : trashIds);
  await persistBrowseSession();
}

export async function filterAccessibleCachedMedia(items, { allowReviewed = false } = {}) {
  const cached = Array.isArray(items) ? items : [];
  if (USE_MOCK || !cached.length) return cached;
  const reviewed = allowReviewed ? new Set() : await primeReviewed(cached);
  const accessible = [];
  const batchSize = 8;
  for (let offset = 0; offset < cached.length; offset += batchSize) {
    const batch = cached.slice(offset, offset + batchSize).filter(item => !reviewed.has(item.id) && !isTrashAsset(item.id));
    const nativeIds = await accessibleNativeAssetIds(batch.map(item => item.id));
    if (nativeIds) {
      const allowed = new Set(nativeIds); accessible.push(...batch.filter(item => allowed.has(item.id))); continue;
    }
    const checked = await Promise.all(batch.map(async (item) => {
      try {
        const info = await MediaLibrary.getAssetInfoAsync(item.id, { shouldDownloadFromNetwork: false });
        return info?.id ? item : null;
      } catch (error) {
        throw error;
      }
    }));
    accessible.push(...checked.filter(Boolean));
  }
  return accessible;
}

export async function markAssetViewed(item) {
  if (!item?.id) return false;
  await ensureReviewState();
  const changed = USE_MOCK ? !viewedIds.has(item.id) : await reviewStore.review(item.id);
  viewedIds.add(item.id);
  memorySession?.failedDisplayIds.delete(item.id);
  if (changed) reviewedCount++;
  return changed;
}
export function reportMediaDisplayFailure(item) {
  if (!item?.id || !memorySession) return;
  memorySession.failedDisplayIds.add(item.id);
  mediaUpdateListeners.forEach(listener => { try { listener({ type: 'media-display-failed', asset: item }); } catch {} });
}
export function getUnresolvedMediaCount() {
  return (memorySession?.failedDisplayIds.size || 0) + (memorySession?.failedCloudIds.size || 0);
}
export async function clearViewedHistory() {
  await ensureReviewState();
  if (!USE_MOCK) await reviewStore.clearReviewed();
  viewedIds.clear();
  reviewedCount = 0;
}

// ---------------- Mock ----------------

function buildMockItems() {
  if (mockItems) return mockItems;
  const now = Date.now();
  mockItems = Array.from({ length: MEMORY_COUNT }, (_, i) => {
    const id = `mock-${i}`;
    const isVideo = i % 6 === 3; // every 6th, starting at index 3
    const isLive = !isVideo && i % 8 === 2; // some photos are "live photos"
    const isTrash = i % 9 === 0; // some pre-marked for demo
    if (isTrash) mockTrashIds.add(id);
    if (isLive) mockFavIds.add(id);
    return {
      id,
      uri: isVideo
        ? SAMPLE_VIDEOS[i % SAMPLE_VIDEOS.length]
        : `https://picsum.photos/seed/vibe${i}/800/1000`,
      displayUri: isVideo
        ? SAMPLE_VIDEOS[i % SAMPLE_VIDEOS.length]
        : `https://picsum.photos/seed/vibe${i}/800/1000`,
      imageUri: isVideo ? null : `https://picsum.photos/seed/vibe${i}/800/1000`,
      mediaType: isVideo ? 'video' : 'photo',
      isLive,
      livePhotoUri: isLive ? SAMPLE_VIDEOS[i % SAMPLE_VIDEOS.length] : null,
      creationTime: now - (MEMORY_COUNT - i) * 86400000 * 3,
      width: 800,
      height: 1000,
      duration: isVideo ? 5000 : null,
      fileSize: isVideo ? 15 * 1024 * 1024 : isLive ? 8 * 1024 * 1024 : 3 * 1024 * 1024,
      filename: isVideo ? `VID_${String(i).padStart(4, '0')}.mp4` : `IMG_${String(i).padStart(4, '0')}.HEIC`,
      isFavorite: mockFavIds.has(id),
      location: MOCK_PLACES[i % MOCK_PLACES.length],
      placeName: '',
      placeShortName: '',
      exif: null,
      isTrash,
    };
  });
  return mockItems;
}

// ---------------- Helpers ----------------

function isVideoAsset(asset) {
  if (!asset) return false;
  // expo-media-library may return a numeric MediaType enum (1/2) or a
  // differently-cased string depending on the native bridge version.
  const mt = String(asset.mediaType || '').toLowerCase();
  if (mt === 'video' || mt === '2') return true;
  if (MediaLibrary?.MediaType && asset.mediaType === MediaLibrary.MediaType.video) return true;
  return false;
}

function isSupportedAsset(asset) {
  if (isVideoAsset(asset)) return true;
  if (!asset) return false;
  const mt = String(asset.mediaType || '').toLowerCase();
  if (mt === 'photo' || mt === 'image' || mt === '1') return true;
  if (MediaLibrary?.MediaType && asset.mediaType === MediaLibrary.MediaType.photo) return true;
  return false;
}

const favoriteCache = new Set();

export function isItemFavorite(item) {
  if (!item) return false;
  if (favoriteCache.has(item.id)) return true;
  return Boolean(item.isFavorite);
}

/** Attach app-level metadata to a legacy asset returned by the OS. */
function extendAsset(a) {
  a.isTrash = trashIds.has(a.id);
  a.isLive = Array.isArray(a.mediaSubtypes) && a.mediaSubtypes.includes('livePhoto');
  a.livePhotoUri = null;
  a.displayUri = null;
  a.imageUri = null;
  a.localUri = null;
  a.previewUri = null;
  a.isPreviewOnly = false;
  a.isFavorite = favoriteCache.has(a.id) || Boolean(a.isFavorite);
  a.location = null;
  a.placeName = '';
  a.placeShortName = '';
  a.exif = null;
  a._nextAsset = null;
  a._basicsAt = 0;
  a.fileSizeBytes = 0;
  a.sizeStatus = 'unknown';
  return a;
}

/** Lazily creates a class-based `Asset` instance (next API) for a legacy asset. */
function getNextAsset(item) {
  if (item._nextAsset) return item._nextAsset;
  const ref = getPhotoKitAssetRef(item);
  if (!ref) throw new Error(`Missing PhotoKit asset id: ${item?.id || item?.uri || 'unknown'}`);
  item._nextAsset = new Asset(ref);
  return item._nextAsset;
}

export function subscribeMediaUpdates(listener) {
  if (typeof listener !== 'function') return () => {};
  mediaUpdateListeners.add(listener);
  return () => mediaUpdateListeners.delete(listener);
}

// ---------------- Public API ----------------

async function getAssetsPage(options) {
  // Keep one ordered query contract for sampling and cursor pagination. A
  // rejected query is not an empty library and must never exhaust its pager.
  return photoLoadStage('library-query', async () => {
    const page = await MediaLibrary.getAssetsAsync(options);
    if (!page || !Array.isArray(page.assets)) throw Error('Invalid PhotoKit page');
    return { ...page, assets: page.assets.filter(isSupportedAsset) };
  });
}

async function getLibraryTimeRange() {
  try {
    const [oldestPage, newestPage] = await Promise.all([
      getAssetsPage({ first: 1, sortBy: [[MediaLibrary.SortBy.creationTime, true]] }),
      getAssetsPage({ first: 1, sortBy: [[MediaLibrary.SortBy.creationTime, false]] }),
    ]);
    const oldestTime = oldestPage?.assets?.[0]?.creationTime || 0;
    const newestTime = newestPage?.assets?.[0]?.creationTime || 0;
    if (oldestTime > 0 && newestTime > oldestTime + 24 * 60 * 60 * 1000) {
      return { oldestTime, newestTime };
    }
  } catch {}
  return null;
}

/**
 * Whole-library stratified random sample.
 *
 * Instead of one contiguous slice (either "newest 240" or "a random time
 * window"), split the library timeline into 8 equal buckets, jitter a random
 * start inside each, and pull a few photos from every bucket. The result is a
 * batch spread across the whole library so the feed never starts inside a
 * single dense era. Burst decks are NOT pre-baked from the whole library here:
 * as the user keeps swiping, the background catalog scan + on-the-fly
 * expansion (tryExpandToBurst) gradually surfaces the remaining burst groups.
 */
/**
 * Whole-library spread sample: 8 time buckets across all eras, but each bucket
 * takes a TIME-CONTIGUOUS neighborhood around a random anchor (forward page +
 * backfill page merged by sampling.mjs). Contiguity is what lets
 * assignBursts/makeFeed regroup natural photo-session clusters into burst
 * decks; taking "the newest N in a wide window" (Build 27 regression) spread
 * the sample across months and left the feed with zero deckable frames.
 */
async function sampleWholeLibrarySpread(limit = INITIAL_SAMPLE_SIZE) {
  const timeRange = await getLibraryTimeRange();
  if (!timeRange) return [];
  const buckets = planSpreadBuckets(timeRange.oldestTime, timeRange.newestTime, limit);
  if (!buckets.length) return [];
  const mediaType = [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video];
  const collected = [];
  const seen = new Set();
  for (const bucket of buckets) {
    const anchor = pickBucketAnchor(bucket);
    const queries = [
      // Forward: the N photos right after the anchor, ascending (consecutive
      // in time, so whole shooting sessions come in as one chunk).
      getAssetsPage({
        first: bucket.count,
        createdAfter: Math.floor(anchor),
        createdBefore: Math.ceil(bucket.end),
        mediaType,
        sortBy: [[MediaLibrary.SortBy.creationTime, true]],
      }),
      // Backfill: the N photos right before the anchor, for anchors near the
      // bucket end (or sparse libraries) where the forward page runs short.
      getAssetsPage({
        first: bucket.count,
        createdBefore: Math.floor(anchor),
        createdAfter: Math.ceil(bucket.start),
        mediaType,
        sortBy: [[MediaLibrary.SortBy.creationTime, false]],
      }),
    ];
    const pages = await Promise.all(queries.map((query) => query.catch(() => ({ assets: [] }))));
    for (const asset of mergeContiguousBucketSample(pages[0]?.assets, pages[1]?.assets, bucket, anchor)) {
      if (!asset?.id || seen.has(asset.id)) continue;
      seen.add(asset.id);
      collected.push(asset);
      if (collected.length >= limit) return collected;
    }
  }
  return collected;
}

async function prepareInitialSession() {
  // Random spread across the WHOLE library (all eras), not a contiguous slice.
  // Falls back to the newest-first sample when the library is too small or
  // PhotoKit is still warming.
  let sampleAssets = [];
  if (!USE_MOCK) {
    try {
      sampleAssets = await sampleWholeLibrarySpread(INITIAL_SAMPLE_SIZE);
    } catch {}
  }

  if (sampleAssets.length < 20) {
    const page = await getAssetsPage({
      first: INITIAL_SAMPLE_SIZE,
      mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
      sortBy: [[MediaLibrary.SortBy.creationTime, false]],
    });
    sampleAssets = page?.assets || [];
  }

  const reviewed = await primeReviewed(sampleAssets);
  await addNativeBurstMetadata(sampleAssets);
  sampleAssets.forEach(extendAsset);
  // Pre-process bursts for the initial sample batch
  assignBursts(sampleAssets);
  const units = buildBurstUnits(sampleAssets).map(unit => ({ ...unit, items: unit.items.filter(item => !reviewed.has(item.id) && !isTrashAsset(item.id)) })).filter(unit => unit.items.length);
  const orderedInitialUnits = currentRecommendMode === 'storage'
    ? sortAndShuffleByStorageImpact(units)
    : shuffle(units);
  const initialUnits = orderedInitialUnits;
  return {
    initialUnits,
    initialOffset: 0,
    cloudReady: [],
    pendingCloudIds: new Set(),
    retryCloudAssets: [],
    failedCloudIds: new RecentIds(4096),
    failedDisplayIds: new RecentIds(4096),
    deferredAssets: [],
    cloudRetryCounts: new Map(),
    attemptedIds: new RecentIds(4096),
    servedIds: new RecentIds(4096),
    seedIds: new Set(sampleAssets.map(item => item.id)),
    pager: null,
    discoveryReady: false,
    discoveryError: null,
  };
}

function hasDiscoveredUnits(session) { return Boolean(session.pager?.hasMore); }
export function startBurstDiscovery(session = memorySession) {
  if (USE_MOCK || !session) return Promise.resolve(null);
  if (!session.pager) session.pager = createCandidatePager({
    fetchPage: options => mediaResources.run(`catalog:${options.after || 'start'}`, 1, async () => { const page = await getAssetsPage({
      ...options, mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
      sortBy: [[MediaLibrary.SortBy.creationTime, false]],
    }); await addNativeBurstMetadata(page.assets); return page; }),
    eligible: async items => {
      const reviewed = await primeReviewed(items);
      return items.filter(item => !reviewed.has(item.id) && !isTrashAsset(item.id) && !session.seedIds.has(item.id));
    },
    group: items => { items.forEach(extendAsset); assignBursts(items); return buildBurstUnits(items); },
    order: units => currentRecommendMode === 'storage' ? sortAndShuffleByStorageImpact(units) : shuffle(units),
  });
  session.discoveryReady = true;
  return Promise.resolve(session);
}
function applyAssetUris(asset, info, fallbackUri) {
  const localUri = info?.localUri || (typeof fallbackUri === 'string' && fallbackUri.startsWith('file://') ? fallbackUri : null);
  const systemUri = info?.uri || fallbackUri || asset.uri || null;
  const displayUri = getRenderableDisplayUri({
    isVideo: isVideoAsset(asset),
    localUri,
    systemUri,
  });
  if (!displayUri) return false;
  asset.localUri = localUri;
  asset.imageUri = isVideoAsset(asset) ? null : displayUri;
  asset.displayUri = displayUri;
  asset.previewUri = null;
  asset.isPreviewOnly = false;
  return true;
}


function applyCloudPreview(asset, info, systemUri) {
  if (isVideoAsset(asset)) {
    const videoRef = getPhotoKitPreviewUri({ isVideo: false, systemUri }) || getPhotoKitAssetRef(asset);
    if (!videoRef || !applyAssetUris(asset, info, videoRef)) return false;
    asset.isPreviewOnly = true;
    return true;
  }
  const previewUri = getPhotoKitPreviewUri({ isVideo: false, systemUri });
  if (!previewUri) return false;
  asset.localUri = null;
  asset.imageUri = null;
  asset.displayUri = null;
  asset.previewUri = previewUri;
  asset.isPreviewOnly = true;
  return true;
}

function classifySystemUri(asset, info, systemUri) {
  if (!systemUri) return 'failed';
  if (isVideoAsset(asset) && !info?.localUri && (systemUri.startsWith('ph://') || systemUri.startsWith('assets-library://'))) {
    return applyCloudPreview(asset, info, systemUri) ? 'preview' : 'failed';
  }
  if (applyAssetUris(asset, info, systemUri)) return 'ready';
  return applyCloudPreview(asset, info, systemUri) ? 'preview' : 'failed';
}

function queueCloudRetry(asset, session) {
  if (!session || !asset?.id || viewedIds.has(asset.id) || isTrashAsset(asset.id)) return;
  if (!session.retryCloudAssets.some((candidate) => candidate.id === asset.id)) {
    session.retryCloudAssets.push(asset);
  }
}

async function getSystemUri(asset, info) {
  if (typeof info?.uri === 'string' && info.uri) return info.uri;
  if (typeof asset.uri === 'string' && asset.uri) return asset.uri;
  try {
    return await getNextAsset(asset).getUri();
  } catch {
    return null;
  }
}

async function inspectAsset(asset) {
  if (supportsNativePhotoPreview) {
    asset.previewUri = getPhotoKitAssetRef(asset);
    if (isVideoAsset(asset)) asset.displayUri = asset.previewUri;
    return { kind: 'ready', asset };
  }
  let info = null;
  try {
    info = await MediaLibrary.getAssetInfoAsync(asset, {
      shouldDownloadFromNetwork: false,
    });
  } catch {}

  // 1. If local file exists, full resolution is immediately ready
  if (info?.localUri && applyAssetUris(asset, info, asset.uri)) {
    return { kind: 'ready', asset };
  }

  // 2. On iOS, photo/video can be displayed as PhotoKit preview immediately without waiting for download
  const photoKitRef = getPhotoKitAssetRef(asset);
  if (photoKitRef) {
    if (isVideoAsset(asset)) {
      if (applyAssetUris(asset, info, photoKitRef)) {
        asset.isPreviewOnly = true;
        return { kind: 'preview', asset };
      }
    } else {
      if (applyCloudPreview(asset, info, photoKitRef)) {
        return { kind: 'preview', asset };
      }
    }
  }

  // 3. Fallback: try system uri
  const systemUri = await getSystemUri(asset, info);
  const kind = classifySystemUri(asset, info, systemUri);
  if (kind === 'ready' || kind === 'preview') return { kind, asset };

  // expo-image cannot reliably render a raw ph:// photo on iOS 18. Export the
  // PhotoKit resource into our sandbox before deciding that the library is empty.
  if (!isVideoAsset(asset) && photoKitRef) {
    const sandboxUri = await getSandboxMediaUri(asset);
    if (sandboxUri && applyAssetUris(asset, { ...info, localUri: sandboxUri, uri: sandboxUri }, sandboxUri)) {
      return { kind: 'ready', asset };
    }
  }

  // A PhotoKit asset without a readable local file is normally iCloud-only.
  // Keep it in the download/retry pipeline instead of silently dropping it.
  if (info?.isNetworkAsset === true || photoKitRef) {
    return { kind: 'cloud', asset };
  }

  return { kind: 'failed', asset };
}

// An iCloud-syncing 100k-photo library fires non-incremental PhotoKit change
// events in bursts; each reload discards the feed and re-runs discovery, so
// back-to-back events reload the world for nothing. Coalesce: one immediate
// reload, suppressed events merged into a single trailing reload once the
// storm settles. A reload is always a full re-read, so merging only delays
// freshness — never correctness.
const LIBRARY_RELOAD_COOLDOWN_MS = 8000;
const libraryReloadCoalescer = createReloadCoalescer({ cooldownMs: LIBRARY_RELOAD_COOLDOWN_MS });
let trailingReloadTimer = null;
let libraryReloadSuppression = 0;
let suppressedReloadCount = 0;

function broadcastLibraryReload() {
  libraryRevision++;
  memorySession = null;
  mediaUpdateListeners.forEach((listener) => {
    try { listener({ type: 'library-reload-required' }); } catch {}
  });
}

function emitLibraryReloadRequired({ force = false } = {}) {
  if (libraryReloadSuppression > 0 && !force) {
    suppressedReloadCount += 1;
    return;
  }
  if (libraryReloadCoalescer.accept(Date.now(), force) === 'emit') {
    flightEvent('library-reload', 'emit');
    broadcastLibraryReload();
    return;
  }
  suppressedReloadCount += 1;
  clearTimeout(trailingReloadTimer);
  trailingReloadTimer = setTimeout(() => {
    trailingReloadTimer = null;
    if (libraryReloadCoalescer.takeTrailing(Date.now())) {
      flightEvent('library-reload', `trailing after ${suppressedReloadCount} suppressed`);
      suppressedReloadCount = 0;
      broadcastLibraryReload();
    }
  }, LIBRARY_RELOAD_COOLDOWN_MS + 1000);
}

/** Suppress storm reloads while an intentional batch mutation is running. */
function withLibraryReloadSuppression(asyncFn) {
  libraryReloadSuppression += 1;
  return asyncFn().finally(() => {
    libraryReloadSuppression -= 1;
    // The batch's own deletions also look like library changes to PhotoKit;
    // fold everything into exactly one reload at the end.
    emitLibraryReloadRequired({ force: true });
  });
}

export function subscribePhotoLibraryChanges() {
  if (USE_MOCK || typeof MediaLibrary.addListener !== 'function') return () => {};
  const subscription = MediaLibrary.addListener((event) => {
    if (!event?.hasIncrementalChanges || (event.deletedAssets?.length || 0) > 0) {
      emitLibraryReloadRequired();
      return;
    }

    const inserted = (event.insertedAssets || []).filter(isSupportedAsset);
    if (!inserted.length || !memorySession) return;
    const known = new Set(memorySession.deferredAssets.map(asset => asset.id));
    const additions = inserted.filter(asset => asset?.id && !known.has(asset.id) && !isTrashAsset(asset.id));
    additions.forEach(extendAsset);
    if (!additions.length) return;
    memorySession.deferredAssets.push(...additions);
    mediaUpdateListeners.forEach((listener) => {
      try { listener({ type: 'library-inserted', count: additions.length }); } catch {}
    });
  });
  return () => subscription?.remove?.();
}

async function downloadCloudAsset(asset, session) {
  let failed = false;
  try {
    const info = await MediaLibrary.getAssetInfoAsync(asset, {
      shouldDownloadFromNetwork: true,
    });
    if (!info?.localUri || !applyAssetUris(asset, info, asset.uri)) {
      failed = true;
      return;
    }
    if (memorySession !== session) {
      if (memorySession && memorySession.servedIds.has(asset.id)) {
        mediaUpdateListeners.forEach((listener) => {
          try { listener({ type: 'asset-ready', asset }); } catch {}
        });
      } else if (memorySession && !viewedIds.has(asset.id) && !isTrashAsset(asset.id)) {
        memorySession.cloudReady.push(asset);
        mediaUpdateListeners.forEach((listener) => {
          try { listener({ type: 'cloud-ready', asset }); } catch {}
        });
      }
      return;
    }
    if (session.servedIds.has(asset.id)) {
      mediaUpdateListeners.forEach((listener) => {
        try { listener({ type: 'asset-ready', asset }); } catch {}
      });
      return;
    }
    if (viewedIds.has(asset.id) || isTrashAsset(asset.id)) return;
    session.cloudReady.push(asset);
    mediaUpdateListeners.forEach((listener) => {
      try {
        listener({ type: 'cloud-ready', asset });
      } catch {}
    });
  } catch (error) {
    failed = true;
    recordCloudFailure();
    console.warn('[media] iCloud download failed:', error?.message || error);
  } finally {
    session.pendingCloudIds.delete(asset.id);
    cloudDownloadIds.delete(asset.id);
    if (failed) {
      const retrySession = memorySession === session
        ? session
        : memorySession?.attemptedIds.has(asset.id)
          ? memorySession
          : null;
      if (!retrySession) return;
      const retryCount = (retrySession.cloudRetryCounts.get(asset.id) || 0) + 1;
      retrySession.cloudRetryCounts.set(asset.id, retryCount);
      if (retryCount <= CLOUD_RETRY_LIMIT) {
        queueCloudRetry(asset, retrySession);
      } else {
        retrySession.failedCloudIds.add(asset.id);
      }
      mediaUpdateListeners.forEach((listener) => {
        try {
          listener({ type: 'cloud-failed', asset });
        } catch {}
      });
    } else {
      session.cloudRetryCounts.delete(asset.id);
      session.failedCloudIds.delete(asset.id);
    }
  }
}

function pumpCloudDownloads() {
  while (cloudDownloadsActive < CLOUD_DOWNLOAD_CONCURRENCY && cloudDownloadQueue.length) {
    const entry = cloudDownloadQueue.shift();
    cloudDownloadsActive += 1;
    void downloadCloudAsset(entry.asset, entry.session).finally(() => {
      cloudDownloadsActive -= 1;
      pumpCloudDownloads();
    });
  }
}

function enqueueCloudDownload(asset, session) {
  if (!session || cloudDownloadIds.has(asset.id) || isTrashAsset(asset.id)) return;
  cloudDownloadIds.add(asset.id);
  session.pendingCloudIds.add(asset.id);
  cloudDownloadQueue.push({ asset, session });
  pumpCloudDownloads();
}

async function resolveAssets(assets, session = memorySession) {
  const resolved = [];
  const diagnostics = { local: 0, cloud: 0, preview: 0, failed: 0 };
  for (let i = 0; i < assets.length; i += RESOLVE_BATCH_SIZE) {
    const batch = assets.slice(i, i + RESOLVE_BATCH_SIZE);
    const results = await Promise.all(batch.map((asset) => mediaResources.run(`inspect:${asset.id}`, 0, () => inspectAsset(asset))));
    for (const result of results) {
      if (result.kind === 'ready') {
        resolved.push(result.asset);
        diagnostics.local += 1;
      } else if (result.kind === 'cloud') {
        diagnostics.cloud += 1;
        enqueueCloudDownload(result.asset, session);
      } else if (result.kind === 'preview') {
        diagnostics.cloud += 1;
        diagnostics.preview += 1;
        resolved.push(result.asset);
        enqueueCloudDownload(result.asset, session);
      } else {
        diagnostics.failed += 1;
      }
    }
  }
  return { items: resolved, diagnostics };
}

function drainCloudReady(session, limit) {
  const ready = [];
  while (session.cloudReady.length && ready.length < limit) {
    const asset = session.cloudReady.shift();
    if (!asset || session.servedIds.has(asset.id) || viewedIds.has(asset.id) || isTrashAsset(asset.id)) continue;
    ready.push(asset);
  }
  return ready;
}

function hasSessionCandidates(session) {
  return browsing.state.overflow.length > 0 || browsing.state.continuations.length > 0 ||
    session.deferredAssets.length > 0 ||
    session.cloudReady.length > 0 ||
    session.retryCloudAssets.length > 0 ||
    session.initialOffset < session.initialUnits.length ||
    !session.discoveryReady ||
    hasDiscoveredUnits(session) ||
    session.pendingCloudIds.size > 0;
}

async function fillBrowseCandidates(session, owner) {
  for (let count = 0; count < 8 && session.retryCloudAssets.length; count++) {
    const asset = session.retryCloudAssets.shift();
    if (asset && !viewedIds.has(asset.id) && !isTrashAsset(asset.id)) enqueueCloudDownload(asset, session);
  }
  // Cloud/deferred media are regular candidates, never inserted directly into the UI.
  const capacity = Math.max(0, owner.policy.candidateLimit - owner.candidateCount);
  const cloudReady = drainCloudReady(session, Math.min(20, capacity));
  const returned = [...cloudReady, ...session.deferredAssets.splice(0, Math.min(40, capacity-cloudReady.length))];
  const returnedReviewed = await primeReviewed(returned);
  if (owner !== browsing || session !== memorySession) return;
  browsing.state.overflow.push(...owner.ingest(returned.filter(item => !returnedReviewed.has(item.id) && !isTrashAsset(item.id))
    .map(item => ({ items: [item] }))));
  if (owner.state.overflow.length) {
    const pending = owner.state.overflow.splice(0);
    owner.state.overflow.push(...owner.ingest(pending));
  }
  if (session.initialOffset < session.initialUnits.length && !browsing.state.overflow.length) {
    browsing.state.overflow = owner.ingest(session.initialUnits.slice(session.initialOffset));
    session.initialOffset = session.initialUnits.length;
  }
  // Fill early, not only after the entire initial sample has been consumed.
  let budget = 2;
  while (budget-- > 0 && owner.candidateCount < 240 && !browsing.state.overflow.length
    && (!owner.hasCandidates || owner.needsBurst || owner.candidateCount < 12)) {
    if (owner.state.continuations.length) {
      const continuation = owner.state.continuations.shift();
      const chunk = await fetchNativeBurstMembers(continuation.nativeId, continuation.nativeOffset);
      if (owner !== browsing || session !== memorySession) return;
      if (!chunk) { owner.state.continuations.unshift(continuation); break; }
      if (chunk.items?.length) {
        const reviewed = await primeReviewed(chunk.items);
        browsing.state.overflow = owner.ingest(chunk.items.filter(i => !reviewed.has(i.id) && !isTrashAsset(i.id))
          .map(item => ({ items: [{ ...item, suppressBurstRegroup: true }] })));
        if (chunk.nextOffset < chunk.count) owner.state.continuations.push({ ...continuation, nativeOffset: chunk.nextOffset, nativeCount: chunk.count });
      }
      continue;
    }
    await startBurstDiscovery(session);
    if (owner !== browsing || session !== memorySession) return;
    if (!session.pager?.hasMore) break;
    const units = await session.pager.next(240, 1);
    if (owner !== browsing || session !== memorySession) return;
    browsing.state.overflow = owner.ingest(units);
  }
  const pending = owner.state.candidates.flatMap(e => e.unit.items);
  const reviewed = await primeReviewed(pending);
  if (owner !== browsing || session !== memorySession) return;
  owner.pruneCandidates(new Set([...reviewed, ...(USE_MOCK ? mockTrashIds : trashIds)]));
}

function stampNativeCount(owner, identifier, count) {
  const items = [...owner.state.entries, ...owner.state.candidates].flatMap(e => e.unit.items)
    .concat(owner.state.deferred, owner.state.overflow.flatMap(unit => unit.items));
  for (const item of items) if (item.nativeBurstId === identifier) item.nativeBurstCount = count;
}
async function expandNativeEntry(entry, owner, offset = 0) {
  const identifier = entry.unit.nativeId || entry.unit.items[0]?.nativeBurstId;
  if (!identifier || !supportsNativePhotoPreview) return;
  const chunk = await fetchNativeBurstMembers(identifier, offset);
  if (!chunk || owner !== browsing) return;
  stampNativeCount(owner, identifier, chunk.count);
  const reviewed = await primeReviewed(chunk.items);
  const knownHere = new Set(entry.unit.items.map(i => i.id));
  const ready = chunk.items.filter(i => (!reviewed.has(i.id) || knownHere.has(i.id)) && !isTrashAsset(i.id));
  const byId = new Map([...(offset > 0 ? entry.unit.items : []), ...ready].map(i => [i.id, i]));
  entry.unit = { ...entry.unit, nativeId: identifier, nativeOffset: chunk.nextOffset, nativeCount: chunk.count,
    items: [...byId.values()].sort((a,b) => a.creationTime-b.creationTime || a.id.localeCompare(b.id)) };
  if (!entry.unit.items.length) owner.queueContinuation(entry.unit);
  // A seed sampled on another page must not later be emitted again.
  const expanded = new Set(entry.unit.items.map(i => i.id));
  owner.state.candidates = owner.state.candidates.map(e => ({ ...e, unit: { ...e.unit,
    items: e.unit.items.filter(i => !expanded.has(i.id)) } })).filter(e => e.unit.items.length);
}

export async function loadMoreNativeGroup(key) {
  const owner = browsing, entry = owner.state.entries.find(e => e.key === key);
  if (!entry || !entry.unit.nativeId || entry.unit.nativeOffset >= entry.unit.nativeCount) return false;
  if (entry.loadingMore) return false;
  entry.loadingMore = true;
  try {
    await expandNativeEntry(entry, owner, entry.unit.nativeOffset);
    if (owner !== browsing) return false;
    const index = entry.unit.items.findIndex(item => item.id === owner.state.anchorId);
    if (index > 40) {
      const removed = entry.unit.items.splice(0, index - 40);
      const reviewed = await primeReviewed(removed);
      owner.state.overflow.push(...owner.ingest(removed.filter(item => !reviewed.has(item.id) && !isTrashAsset(item.id))
        .map(item => ({ items: [{ ...item, suppressBurstRegroup: true }] }))));
    }
    entry.unit.items.forEach(extendAsset);
    mediaUpdateListeners.forEach(listener => listener({ type: 'browse-reconciled' }));
    await persistBrowseSession();
    return true;
  } finally { entry.loadingMore = false; }
}

async function fetchBrowsePage(after) {
  const revision = libraryRevision;
  const owner = await openBrowseSession();
  if (owner !== browsing || revision !== libraryRevision) return { items: [], units: [], hasNextPage: false, stale: true };
  if (USE_MOCK) {
    if (!memorySession) {
      const items = buildMockItems().filter(i => !isTrashAsset(i.id) && !viewedIds.has(i.id));
      assignBursts(items); owner.ingest(buildBurstUnits(items));
      memorySession = { mock: true };
    }
  } else {
    if (!memorySession) {
      const prepared = await photoLoadStage('initial-candidates', prepareInitialSession);
      if (owner !== browsing || revision !== libraryRevision) return { items: [], units: [], hasNextPage: false, stale: true };
      memorySession = prepared;
      memorySession.deferredAssets = owner.state.deferred;
    }
    if (owner !== browsing || revision !== libraryRevision) return { items: [], units: [], hasNextPage: false, stale: true };
    await photoLoadStage('candidate-refill', () => fillBrowseCandidates(memorySession, owner));
  }
  if (owner !== browsing || revision !== libraryRevision) return { items: [], units: [], hasNextPage: false, stale: true };
  const entries = owner.take();
  for (const entry of entries) {
    if (!entry.unit.items[0]?.suppressBurstRegroup) await expandNativeEntry(entry, owner);
    else if (entry.unit.items[0]?.nativeBurstId && !entry.unit.items[0]?.nativeBurstCount) {
      // When native-only supply is presented as singles, still discover every member.
      const seed = entry.unit.items[0];
      const chunk = await fetchNativeBurstMembers(seed.nativeBurstId, 0);
      if (chunk) {
        stampNativeCount(owner, seed.nativeBurstId, chunk.count);
        Object.assign(seed, { nativeBurstCount: chunk.count, nativeBurstOffset: chunk.nextOffset });
        const more = chunk.items.filter(i => i.id !== seed.id).map(i => ({ items: [{ ...i, suppressBurstRegroup: true }] }));
        owner.state.overflow.push(...owner.ingest(more));
        owner.queueContinuation({ nativeId: seed.nativeBurstId, nativeOffset: chunk.nextOffset, nativeCount: chunk.count });
      }
    }
    entry.unit.items.forEach(extendAsset);
  }
  if (owner !== browsing || revision !== libraryRevision) return { items: [], units: [], hasNextPage: false, stale: true };
  const raw = entries.flatMap(e => e.unit.items);
  const resolved = USE_MOCK ? { items: raw, diagnostics: {} } : await photoLoadStage('media-resolution', () => resolveAssets(raw, memorySession));
  if (owner !== browsing || revision !== libraryRevision) return { items: [], units: [], hasNextPage: false, stale: true };
  const reviewedNow = await primeReviewed(resolved.items);
  const available = new Map(resolved.items.filter(i => !reviewedNow.has(i.id) && !isTrashAsset(i.id)).map(i => [i.id, i]));
  for (const entry of entries) entry.unit.items = entry.unit.items.filter(i => available.has(i.id)).map(i => available.get(i.id));
  owner.state.entries = owner.state.entries.filter(e => e.unit.items.length);
  const units = entries.filter(e => e.unit.items.length), items = units.flatMap(e => e.unit.items);
  const hasNextPage = owner.hasCandidates || owner.state.continuations.length > 0
    || (!USE_MOCK && hasSessionCandidates(memorySession));
  cachedAssets = [...new Map([...cachedAssets, ...items].map(i => [i.id, i])).values()].slice(-240);
  const status = items.length ? 'ready' : !USE_MOCK && (memorySession.pendingCloudIds.size || memorySession.retryCloudAssets.length)
    ? 'cloud-pending' : !USE_MOCK && memorySession.failedCloudIds.size ? 'error'
    : hasNextPage ? 'loading' : reviewedCount > 0 ? 'all-viewed' : 'empty-library';
  if (!owner.state.anchorId) owner.restoreAnchor(USE_MOCK ? mockTrashIds : trashIds);
  await persistBrowseSession();
  return { items, units, endCursor: hasNextPage ? 'next' : null, hasNextPage, status, diagnostics: resolved.diagnostics };
}
export function fetchMemoryPage(limit = 50, after = null) {
  if (pageRequest) return pageRequest;
  const task = fetchBrowsePage(after);
  pageRequest = task;
  return task.finally(() => { if (pageRequest === task) pageRequest = null; });
}

// Local calendar-day key, allocation-free (getLocalDayKey in mediaPage.mjs):
// filtering a 100k catalog with a `new Date()` per asset was a needless
// allocation storm on the "back to that day" pinch.
function dayKey(creationTime) {
  return getLocalDayKey(creationTime);
}

export function openDaySession(anchor) {
  if (!anchor) return null;
  return createDayPager({ anchor, eligible: item => !isTrashAsset(item.id), fetchPage: async ({ ascending, ...options }) => {
    if (USE_MOCK) {
      const pool = buildMockItems().filter(item => item.creationTime > options.createdAfter && item.creationTime < options.createdBefore)
        .sort((a,b) => ascending ? a.creationTime-b.creationTime : b.creationTime-a.creationTime);
      const offset = Number(options.after || 0), assets = pool.slice(offset, offset+options.first);
      return { assets, hasNextPage: offset+assets.length<pool.length, endCursor: String(offset+assets.length) };
    }
    return mediaResources.run(`day:${anchor.id}:${ascending}:${options.after || 'start'}`, 1, () => getAssetsPage({
      ...options, mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
      sortBy: [[MediaLibrary.SortBy.creationTime, ascending]],
    }));
  } });
}
export async function fetchDayPage(session, side) {
  const assets = await session.next(side);
  return assets.filter(item => !isTrashAsset(item.id)).map(item => {
    extendAsset(item);
    if (supportsNativePhotoPreview) {
      item.previewUri = getPhotoKitAssetRef(item);
      if (isVideoAsset(item)) item.displayUri = item.previewUri;
    }
    return item;
  });
}
// Compatibility caller: bounded opening neighbourhood; live browsing owns cursors.
export async function fetchDayItems(anchor) {
  const session = openDaySession(anchor);
  if (!session) return [];
  const before = await fetchDayPage(session, 'before'), after = await fetchDayPage(session, 'after');
  return [...before, anchor, ...after];
}

export async function fetchMemoryItems(limit = MEMORY_COUNT) {
  const { items } = await fetchMemoryPage(limit);
  return items;
}

/** Last-resort URI resolver. On iOS 18+, the raw file:// inside the system
 * photo library (/var/mobile/Media/...) is sandboxed and unreadable, and the
 * ph:// URI is only readable by expo-video (which strips "ph://" from the FULL
 * absoluteString) — expo-image's PhotoKit loader reads only url.host and
 * truncates localIdentifiers that contain "/L0/...". The ONLY universally
 * readable source is a real file inside our own app sandbox, obtained by
 * copying the asset through the native PHAssetResourceManager channel
 * (expo-file-system copyAsync supports ph:// sources). */
export async function getSandboxMediaUri(item) {
  if (!item || !SANDBOX_MEDIA_DIR) return null;
  if (USE_MOCK) return item.imageUri || item.uri || null;
  if (sandboxMediaCache.has(item.id)) return sandboxMediaCache.get(item.id);
  const ref = getPhotoKitAssetRef(item);
  if (!ref) return null;
  const filename = item.filename || (isVideoAsset(item) ? 'video.mov' : 'photo.jpg');
  const ext = filename.includes('.') ? filename.split('.').pop().toLowerCase() : (isVideoAsset(item) ? 'mov' : 'jpg');
  const safeName = item.id.replace(/[^a-zA-Z0-9_-]/g, '_');
  const target = `${SANDBOX_MEDIA_DIR}${safeName}.${ext}`;
  try {
    await FileSystem.makeDirectoryAsync(SANDBOX_MEDIA_DIR, { intermediates: true });
    const info = await FileSystem.getInfoAsync(target);
    // A zero-byte leftover (interrupted copyAsync) must never be treated as a
    // valid export — delete it so the copy below runs again.
    if (info.exists && typeof info.size === 'number' && info.size === 0) {
      await FileSystem.deleteAsync(target, { idempotent: true });
      info.exists = false;
    }
    if (!info.exists) {
      await FileSystem.copyAsync({ from: ref, to: target });
    }
    const copiedInfo = info.exists ? info : await FileSystem.getInfoAsync(target);
    if (copiedInfo.exists && typeof copiedInfo.size === 'number' && copiedInfo.size > 0) {
      item.fileSizeBytes = copiedInfo.size;
      item.sizeStatus = 'ready';
    }
    sandboxMediaCache.set(item.id, target);
    scheduleSandboxPruning();
    return target;
  } catch (error) {
    console.warn('[media] sandbox export failed:', item.filename || item.id, error?.message || error);
    return null;
  }
}

const sandboxMediaCache = new LRUMap(50);
let pruneDirectoryTimer = null;

export async function pruneSandboxDirectory(maxFiles = 50) {
  if (!SANDBOX_MEDIA_DIR || USE_MOCK) return;
  try {
    const info = await FileSystem.getInfoAsync(SANDBOX_MEDIA_DIR);
    if (!info.exists || !info.isDirectory) return;
    const files = await FileSystem.readDirectoryAsync(SANDBOX_MEDIA_DIR);
    if (files.length <= maxFiles) return;
    const fileStats = await Promise.all(
      files.map(async (name) => {
        const path = `${SANDBOX_MEDIA_DIR}${name}`;
        const stat = await FileSystem.getInfoAsync(path);
        return { path, modificationTime: stat.modificationTime || 0 };
      })
    );
    fileStats.sort((a, b) => a.modificationTime - b.modificationTime);
    const toDelete = fileStats.slice(0, fileStats.length - maxFiles);
    const deletedPaths = new Set();
    for (const item of toDelete) {
      await FileSystem.deleteAsync(item.path, { idempotent: true });
      deletedPaths.add(item.path);
    }
    // Keep the in-memory cache coherent with disk (ISSUE-006): a cached path
    // whose backing file was just pruned must not be handed out again, or
    // ExpoImage gets a dead file:// and the photo renders as a silent black
    // tile. The next getSandboxMediaUri call re-exports it.
    if (deletedPaths.size) {
      for (const [cachedId, cachedPath] of sandboxMediaCache.entries()) {
        if (deletedPaths.has(cachedPath)) sandboxMediaCache.delete(cachedId);
      }
    }
  } catch {}
}

function scheduleSandboxPruning() {
  clearTimeout(pruneDirectoryTimer);
  pruneDirectoryTimer = setTimeout(() => {
    void pruneSandboxDirectory(50);
  }, 4000);
}

/** Last-resort URI resolver. On iOS 18+, the raw file:// inside the system
 * photo library (/var/mobile/Media/...) is sandboxed and unreadable, and the
 * ph:// URI is only readable by expo-video (which strips "ph://" from the FULL
 * absoluteString) — expo-image's PhotoKit loader reads only url.host and
 * truncates localIdentifiers that contain "/L0/...". The ONLY universally
 * readable source is the permission-bearing temporary URI from the next-API
 * Asset.getUri(): PHContentEditingInput.fullSizeImageURL for images,
 * requestAVAsset's AVURLAsset.url for videos. */
export async function getUriFallback(item) {
  if (!item) return null;
  if (USE_MOCK) return item.imageUri || item.uri || null;
  if (!isVideoAsset(item)) {
    // Photos / live photos / burst frames: copy into the sandbox — this is the
    // ONLY source ExpoImage can reliably read on iOS 18+ (small files, cached).
    try {
      const sandboxed = await getSandboxMediaUri(item);
      if (typeof sandboxed === 'string' && sandboxed.startsWith('file://')) return sandboxed;
    } catch {}
  }
  // Videos: prefer the fast permission-bearing temporary URI (requestAVAsset).
  // Do NOT copy the (potentially large) video here — the first-frame thumbnail
  // flow falls back to a sandbox copy only when this URI is unreadable.
  try {
    const uri = await getNextAsset(item).getUri();
    if (typeof uri === 'string' && uri.startsWith('file://')) return uri;
  } catch {}
  // Legacy fallbacks.
  if (isVideoAsset(item)) {
    const videoUri = getRenderableDisplayUri({
      isVideo: true,
      localUri: item.localUri,
      systemUri: item.displayUri,
    });
    if (videoUri) return videoUri;
  } else {
    const imageUri = getRenderableImageUri(item.imageUri) || getRenderableImageUri(item.displayUri);
    if (imageUri) return imageUri;
  }
  return null;
}

let trashItemsListCache = [];
const trashMetadataListeners = new Set();
export function subscribeTrashMetadata(listener) {
  trashMetadataListeners.add(listener);
  return () => trashMetadataListeners.delete(listener);
}

export function getTrashCount() {
  return USE_MOCK ? mockTrashIds.size : trashIds.size;
}

/** Get items currently marked for deletion (0ms instant queue cache return). */
export async function fetchTrashItems(limit = 120, offset = 0) {
  await loadTrashHistory();
  if (USE_MOCK) return buildMockItems().filter(item => mockTrashIds.has(item.id)).slice(offset, offset + limit);
  const rows = await reviewStore.trashPage(limit, offset);
  const cached = new Map([...cachedAssets, ...trashItemsListCache].map(item => [item.id, item]));
  const items = rows.map(row => cached.get(row.id) || {
    id: row.id, isTrash: true, fileSizeBytes: row.size_bytes || 0,
    previewUri: `ph://${row.id}`, displayUri: `ph://${row.id}`, mediaType: 'photo',
  });
  // Metadata enrichment is limited to this page, never the entire pending bin.
  void mapLimit(items.filter(item => !item.filename), 3, async item => {
    if (trashDeletionPending || !isTrashAsset(item.id)) return;
    try {
      const info = await mediaResources.run(`trash-meta:${item.id}`, 0, () => MediaLibrary.getAssetInfoAsync(item.id, { shouldDownloadFromNetwork: false }));
      if (info && !trashDeletionPending && isTrashAsset(item.id)) {
        Object.assign(item, info);
        for (const listener of trashMetadataListeners) {
          try { listener(item); } catch {}
        }
      }
    } catch {}
  });
  trashItemsListCache = [...new Map([...items, ...trashItemsListCache].map(item => [item.id,item])).values()].slice(0,600);
  return items;
}

/** Best-effort file size in bytes (0 when the OS does not expose it).
 * Priority: in-memory fileSize → real local file stat → next-API getSize.
 * Pass { allowNetwork: false } to skip iCloud-only resolution (summary paths). */
export async function getAssetSizeBytes(item, { allowNetwork = true } = {}) {
  if (!item) return 0;
  if (typeof item.fileSizeBytes === 'number' && item.fileSizeBytes > 0) return item.fileSizeBytes;
  if (typeof item.fileSize === 'number' && item.fileSize > 0) {
    item.fileSizeBytes = item.fileSize;
    item.sizeStatus = 'ready';
    return item.fileSizeBytes;
  }
  const localCandidates = [item.localUri, item.imageUri, item.displayUri]
    .map((uri) => getRenderableImageUri(uri))
    .filter(Boolean);
  for (const uri of localCandidates) {
    try {
      const info = await FileSystem.getInfoAsync(uri);
      if (info.exists && typeof info.size === 'number' && info.size > 0) {
        item.fileSizeBytes = info.size;
        item.sizeStatus = 'ready';
        return info.size;
      }
    } catch {
      // ignore
    }
  }
  if (!USE_MOCK && allowNetwork) {
    try {
      const info = await MediaLibrary.getAssetInfoAsync(item, {
        shouldDownloadFromNetwork: true,
      });
      const localUri = info?.localUri;
      if (localUri) {
        item.localUri = localUri;
        if (!isVideoAsset(item)) item.imageUri = localUri;
        const stat = await FileSystem.getInfoAsync(localUri);
        if (stat.exists && typeof stat.size === 'number' && stat.size > 0) {
          item.fileSizeBytes = stat.size;
          item.sizeStatus = 'ready';
          return stat.size;
        }
      }
      if (typeof info?.size === 'number' && info.size > 0) {
        item.fileSizeBytes = info.size;
        item.sizeStatus = 'ready';
        return info.size;
      }
    } catch {
      // ignore
    }
  }
  try {
    const na = getNextAsset(item);
    if (typeof na.getSize === 'function') {
      const s = await na.getSize();
      if (typeof s === 'number' && s > 0) {
        item.fileSizeBytes = s;
        item.sizeStatus = 'ready';
        return s;
      }
    }
  } catch {
    // ignore
  }
  item.sizeStatus = 'unknown';
  return 0;
}

/** Trash box summary: item count + total storage in bytes (0ms instant return). */

export async function fetchTrashSummary({ limit = 120, offset = 0 } = {}) {
  await ensureReviewState();
  const items = limit > 0 ? await fetchTrashItems(limit, offset) : [];
  if (USE_MOCK) return { items, count: mockTrashIds.size, sizeBytes: mockTrashIds.size * 3355443, unknownCount: mockTrashIds.size };
  const summary = await reviewStore.trashSummary();
  return { items, count: summary.count, sizeBytes: summary.known_bytes + summary.unknown_count * 3355443, unknownCount: summary.unknown_count };
}

const mockCleanupReceipts = new Map();
/** Commit allowance and pending state together before the card leaves. */
export async function selectForCleanup(asset, policy) {
  const owner = browsing;
  await ensureReviewState();
  let result;
  if (USE_MOCK) {
    const receipts = mockCleanupReceipts.get(policy.date) || new Set();
    mockCleanupReceipts.set(policy.date, receipts);
    const existing = mockTrashIds.has(asset.id);
    if (!existing && !receipts.has(asset.id) && policy.charge && receipts.size >= policy.limit) return { allowed: false, changed: false, used: receipts.size };
    if (!existing && policy.charge) receipts.add(asset.id);
    result = { allowed: true, changed: !existing, used: receipts.size };
  } else {
    result = await reviewStore.selectForCleanup(asset.id, { ...policy, size: asset.fileSizeBytes || asset.fileSize || null,
      checkpoint: () => owner.snapshot({ blocked: trashIds, removeId: asset.id }) });
  }
  if (result.allowed) {
    updatePendingCache(asset, true);
    if (owner === browsing) owner.restoreAnchor(USE_MOCK ? mockTrashIds : trashIds);
  }
  return result;
}

function updatePendingCache(asset, mark) {
  asset.suppressBurstRegroup = true;
  asset.isTrash = mark;
  const ids = USE_MOCK ? mockTrashIds : trashIds;
  if (mark) {
    ids.add(asset.id);
    if (!trashItemsListCache.some(item => item.id === asset.id)) {
      trashItemsListCache.unshift(asset);
      trashItemsListCache = trashItemsListCache.slice(0,600);
    }
  } else {
    ids.delete(asset.id);
    trashItemsListCache = trashItemsListCache.filter(item => item.id !== asset.id);
  }
}

/** Restore an asset out of the pending-deletion box. */
export function restoreFromTrash(asset, { focus = false } = {}) {
  if (focus) {
    if (!browsing.getItem(asset.id)) browsing.reconcile([...browsing.state.entries.flatMap(e => e.unit.items), asset]);
    browsing.anchor(asset.id); browsing.leaveDay();
  }
  markForTrash(asset, false);
}

const trashMutationVersion = new Map();
/** Mark or unmark an asset for pending deletion. */
export function markForTrash(asset, mark) {
  if (!asset?.id) return;
  updatePendingCache(asset, mark);
  if (!USE_MOCK) {
    const version = (trashMutationVersion.get(asset.id) || 0) + 1;
    trashMutationVersion.set(asset.id, version);
    void reviewStore.setPending(asset.id, mark, asset.fileSizeBytes || asset.fileSize || null,
      () => browsing.snapshot({ blocked: trashIds })).catch(error => {
      if (trashMutationVersion.get(asset.id) !== version) return;
      if (mark) trashIds.delete(asset.id); else trashIds.add(asset.id);
      asset.isTrash = !mark;
      trashItemsListCache = trashItemsListCache.filter(item => item.id !== asset.id);
      mediaUpdateListeners.forEach(listener => listener({ type: 'operation-failed', asset, error }));
    }).finally(() => { if (trashMutationVersion.get(asset.id) === version) trashMutationVersion.delete(asset.id); });
  }
}

/** One identifier-only PhotoKit transaction; the system owns the sole confirmation.
 * Never retry by splitting a failed/cancelled transaction into more system sheets. */
const deletePendingTrash = createTrashDeletion({
  getIds: () => USE_MOCK ? mockTrashIds : trashIds,
  before: async ids => {
    if (USE_MOCK) return null;
    await ensureReviewState();
    await reviewStore.flush();
    const pendingRows = await reviewStore.trashPage(ids.length, 0);
    const byId = new Map(pendingRows.map(row => [row.id, { fileSizeBytes: row.size_bytes }]));
    const sizes = Object.fromEntries(ids.map(id => {
      const item = byId.get(id);
      return [id, item?.fileSizeBytes || item?.fileSize || 3355443];
    }));
    const job = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, ids, sizes };
    await reviewStore.beginDeletion(job.id, { ids, sizes });
    return job;
  },
  cancel: async job => { if (job) await reviewStore.abandonDeletion(job.id); },
  remove: async (ids) => {
    if (!USE_MOCK) return deleteAssetsWithSystemConfirmation(ids, MediaLibrary.deleteAssetsAsync);
    const removed = new Set(ids);
    mockItems = buildMockItems().filter((item) => !removed.has(item.id));
    return true;
  },
  commit: async (deletedIds, job) => {
    let deletedBytes = 0;
    for (const item of trashItemsListCache) {
      if (deletedIds.has(item.id)) deletedBytes += item.fileSizeBytes || item.fileSize || 3355443;
    }
    deletedBytes = deletedBytes || deletedIds.size * 3355443;
    if (job) {
      deletedBytes = [...deletedIds].reduce((sum, id) => sum + (job.sizes[id] || 0), 0);
      await reviewStore.completeDeletion(job.id, [...deletedIds], deletedBytes);
    }
    totalCleanedSizeBytes += deletedBytes;
    // Reconcile memory before awaiting IO: no stale grid or double accounting.
    cachedAssets = cachedAssets.filter((item) => !deletedIds.has(item.id));
    trashItemsListCache = trashItemsListCache.filter((item) => !deletedIds.has(item.id));
    for (const id of deletedIds) {
      trashIds.delete(id);
      mockTrashIds.delete(id);
    }
    flightEvent('empty-trash', `${deletedIds.size} deleted in one transaction`);
  },
});

let trashDeletionPending = null;
export async function emptyTrash() {
  if (trashDeletionPending) return trashDeletionPending;
  const idsAtStart = Array.from(USE_MOCK ? mockTrashIds : trashIds);
  trashDeletionPending = withLibraryReloadSuppression(async () => {
    if (!USE_MOCK) {
      await reconcilePendingDeletion({ allowDuringDelete: true });
      if ((await reviewStore.jobs()).length) throw Error('Previous deletion result is not yet verifiable');
    }
    return deletePendingTrash(idsAtStart.filter(id => USE_MOCK ? mockTrashIds.has(id) : trashIds.has(id)));
  })
    .finally(() => { trashDeletionPending = null; });
  return trashDeletionPending;
}

/** Resolve interrupted transactions only with full permission and definitive
 * native absence. Errors/limited permission never mean "deleted". */
export async function reconcilePendingDeletion({ allowDuringDelete = false } = {}) {
  if (USE_MOCK) return;
  const jobs = await reviewStore.jobs();
  if (!jobs.length) return;
  const permission = await MediaLibrary.getPermissionsAsync(false, ['photo']);
  if (!permission.granted || permission.accessPrivileges !== 'all') return;
  for (const job of jobs) {
    if (trashDeletionPending && !allowDuringDelete) return;
    const missing = [], unresolved = [];
    await mapLimit(job.ids, 3, async id => {
      try {
        const info = await mediaResources.run(`reconcile:${id}`, 2, () => MediaLibrary.getAssetInfoAsync(id, { shouldDownloadFromNetwork: false }));
        if (info === null) missing.push(id);
      } catch { unresolved.push(id); }
    });
    const bytes = missing.reduce((sum,id) => sum + (job.sizes[id] || 0),0);
    const applied = await reviewStore.completeDeletion(job.id, missing, bytes, unresolved.length ? { ids: unresolved, sizes: job.sizes } : null);
    if (!applied) continue;
    totalCleanedSizeBytes += bytes;
    for (const id of missing) trashIds.delete(id);
    const removed = new Set(missing);
    cachedAssets = cachedAssets.filter(item => !removed.has(item.id));
    trashItemsListCache = trashItemsListCache.filter(item => !removed.has(item.id));
    if (missing.length) emitLibraryReloadRequired();
  }
}

/** Extract the paired video of a Live Photo to a playable temporary `file://` URI. */
export async function loadLivePhotoUri(item) {
  if (item.livePhotoUri || !item.isLive) return item.livePhotoUri;
  if (USE_MOCK) return null;
  try {
    item.livePhotoUri = await mediaResources.run(`live:${item.id}`, 0, () => getNextAsset(item).getLivePhotoVideoUri());
  } catch {
    item.livePhotoUri = null;
  }
  return item.livePhotoUri;
}

/**
 * Resolve the URI that image / video views can render.
 *
 * Photos resolve to a local `file://` URI. Videos may keep their PhotoKit
 * `ph://` URI for VideoView playback, while image views only receive local
 * files. iCloud-only assets are handled by the background page resolver.
 */
export async function getDisplayUri(item) {
  if (!item) return null;
  if (isVideoAsset(item)) {
    const videoUri = getRenderableDisplayUri({
      isVideo: true,
      localUri: item.localUri,
      systemUri: item.displayUri,
    });
    if (videoUri) return videoUri;
  } else {
    const imageUri = getRenderableImageUri(item.imageUri) || getRenderableImageUri(item.displayUri);
    if (imageUri) {
      item.localUri = imageUri;
      item.imageUri = imageUri;
      item.displayUri = imageUri;
      return imageUri;
    }
  }
  if (USE_MOCK) {
    item.displayUri = item.uri;
    item.imageUri = isVideoAsset(item) ? null : item.uri;
    return item.displayUri;
  }
  try {
    const assetInfo = await MediaLibrary.getAssetInfoAsync(item, {
      shouldDownloadFromNetwork: false,
    });
    let systemUri = assetInfo?.uri || item.uri || null;
    if (!assetInfo?.localUri) {
      try {
        const inCloud = await getNextAsset(item).getIsInCloud();
        if (inCloud === true) return null;
        systemUri = systemUri || await getNextAsset(item).getUri();
      } catch {}
    }
    if (!applyAssetUris(item, assetInfo, systemUri)) return null;
    if (item.displayUri) {
      console.log('[media] local file resolved:', item.filename, item.displayUri);
    } else {
      console.warn('[media] no local file (in cloud?):', item.filename, item.id);
    }
  } catch (e) {
    item.displayUri = null;
    console.warn('[media] resolve local file failed:', item.filename, e?.message || e);
  }
  return item.displayUri;
}

/** Lazily load favorite state + GPS location for the current item. */
// In-flight dedupe: MemoryCard AND MemoryInfoPanel both call loadItemBasics
// for the same item at nearly the same moment (card becomes active), which
// used to run the whole getFavorite+getLocation native chain twice in
// parallel. Completed calls short-circuit via the _basicsAt guard inside
// performLoadItemBasics; this map covers the in-flight window.
const loadItemBasicsInFlight = new Map();

export function loadItemBasics(item) {
  if (!item) return Promise.resolve();
  const existing = loadItemBasicsInFlight.get(item.id);
  if (existing) return existing;
  const started = mediaResources.run(`basics:${item.id}`, 2, () => performLoadItemBasics(item)).finally(() => {
    loadItemBasicsInFlight.delete(item.id);
  });
  loadItemBasicsInFlight.set(item.id, started);
  return started;
}

async function performLoadItemBasics(item) {
  if (!item) return;
  if (USE_MOCK) {
    const isFav = mockFavIds.has(item.id);
    item.isFavorite = isFav;
    if (isFav) favoriteCache.add(item.id);
    else favoriteCache.delete(item.id);
    item.location = item.location || { latitude: 31.2304, longitude: 121.4737 };
    return;
  }
  if (item._basicsAt && item.location) {
    item.isFavorite = favoriteCache.has(item.id) || Boolean(item.isFavorite);
    return;
  }
  item._basicsAt = Date.now();
  try {
    const na = getNextAsset(item);
    const favVal = await na.getFavorite();
    item.isFavorite = Boolean(favVal);
    if (favVal) favoriteCache.add(item.id);
    else favoriteCache.delete(item.id);
  } catch {
    item.isFavorite = favoriteCache.has(item.id) || Boolean(item.isFavorite);
  }
  try {
    const na = getNextAsset(item);
    const loc = await na.getLocation();
    if (loc && typeof loc.latitude === 'number' && typeof loc.longitude === 'number') {
      item.location = loc;
    }
  } catch {
    // ignore
  }
  // Fallback: check EXIF for GPS coordinates
  if (!item.location) {
    try {
      const exif = item.exif || (await getNextAsset(item).getExif());
      if (exif) {
        item.exif = exif;
        const gps = exif['{GPS}'] || exif.GPS || exif;
        let lat = gps?.Latitude ?? gps?.GPSLatitude;
        let lon = gps?.Longitude ?? gps?.GPSLongitude;
        const latRef = gps?.LatitudeRef ?? gps?.GPSLatitudeRef;
        const lonRef = gps?.LongitudeRef ?? gps?.GPSLongitudeRef;
        if (typeof lat === 'number' && typeof lon === 'number') {
          if (latRef === 'S' || latRef === 's') lat = -lat;
          if (lonRef === 'W' || lonRef === 'w') lon = -lon;
          item.location = { latitude: lat, longitude: lon };
        }
      }
    } catch {
      // ignore
    }
  }
}

/** Read EXIF dictionary (device info etc.) for the current item. */
export async function loadExif(item) {
  if (!item) return {};
  if (item.exif) return item.exif;
  if (USE_MOCK) {
    item.exif = {
      Make: 'Apple',
      Model: 'iPhone 16 Pro',
      LensModel: 'iPhone 16 Pro back dual wide camera',
    };
    return item.exif;
  }
  try {
    item.exif = (await getNextAsset(item).getExif()) || {};
  } catch {
    item.exif = {};
  }
  return item.exif;
}

/** Return an already-known local place label without sending photo GPS data off-device. */
export async function getPlaceName(item) {
  if (!item) return '';
  return item.placeShortName || item.placeName || '';
}

export function releaseUnviewedBurstFrames(items, activeId) {
  const session = memorySession;
  const entry = browsing.state.entries.find(e => e.unit.items.some(i => i.id === items?.[0]?.id));
  if (entry) browsing.queueContinuation(entry.unit);
  if (!session || !Array.isArray(items) || items.length < 2) return new Set();
  const queued = new Set(session.deferredAssets.map((item) => item.id));
  const released = new Set();
  for (const item of items) {
    if (!item?.id || item.id === activeId || viewedIds.has(item.id) || isTrashAsset(item.id) || queued.has(item.id)) continue;
    session.attemptedIds.delete(item.id);
    session.servedIds.delete(item.id);
    // Once a user leaves a deck, unseen siblings must return later as new
    // cards. Otherwise makeFeed() would group them back into the old deck.
    item.suppressBurstRegroup = true;
    delete item.burstId;
    delete item.burstIndex;
    delete item.burstCount;
    session.deferredAssets.push(item);
    queued.add(item.id);
    released.add(item.id);
  }
  return released;
}

/** Mark an item as favorite without ever removing an existing favorite. */
export async function ensureFavorite(item) {
  if (!item) return { favorite: false, changed: false };
  favoriteCache.add(item.id);
  item.isFavorite = true;
  if (USE_MOCK) {
    const changed = !mockFavIds.has(item.id);
    mockFavIds.add(item.id);
    return { favorite: true, changed };
  }
  try {
    const na = getNextAsset(item);
    const favorite = await na.getFavorite();
    if (favorite) {
      return { favorite: true, changed: false };
    }
    await na.setFavorite(true);
    return { favorite: true, changed: true };
  } catch {
    return { favorite: true, changed: false };
  }
}

/** Toggle an item's favorite state and mirror the result onto the feed object. */
const favoriteOperations = new Map();
export function toggleFavorite(item) {
  if (!item?.id) return Promise.resolve({ favorite: false, changed: false });
  if (favoriteOperations.has(item.id)) return favoriteOperations.get(item.id);
  const current = favoriteCache.has(item.id) || Boolean(item.isFavorite);
  const next = !current;
  const operation = (async () => {
    try {
      if (!USE_MOCK) await getNextAsset(item).setFavorite(next);
      if (next) favoriteCache.add(item.id); else favoriteCache.delete(item.id);
      if (USE_MOCK) { if (next) mockFavIds.add(item.id); else mockFavIds.delete(item.id); }
      item.isFavorite = next;
      return { favorite: next, changed: true };
    } catch (error) {
      mediaUpdateListeners.forEach(listener => listener({ type: 'operation-failed', asset: item, error }));
      return { favorite: current, changed: false, failed: true };
    }
  })().finally(() => favoriteOperations.delete(item.id));
  favoriteOperations.set(item.id, operation);
  return operation;
}

/** Resolve a local `file://` URI usable by the native share sheet. */
export async function getShareUri(item) {
  if (!item) return '';
  if (USE_MOCK) return item.uri;
  try {
    return (await getDisplayUri(item)) || item.uri;
  } catch {
    return item.uri;
  }
}

export { isVideoAsset };

