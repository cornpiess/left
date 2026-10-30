export function getRenderableDisplayUri({ isVideo, localUri, systemUri }) {
  if (isVideo) {
    // Videos MUST use the PhotoKit URI (ph:// / assets-library://) on iOS.
    if (typeof systemUri === 'string' && (systemUri.startsWith('ph://') || systemUri.startsWith('assets-library://'))) {
      return systemUri;
    }
    if (typeof localUri === 'string' && localUri.startsWith('file://') && localUri.includes('/Containers/')) {
      return localUri;
    }
    if (typeof localUri === 'string' && localUri.startsWith('file://')) return localUri;
    if (typeof systemUri === 'string' && systemUri.startsWith('file://')) return systemUri;
    return null;
  }
  return localUri?.startsWith('file://') ? localUri : null;
}

export function mergeStartupMedia({ cachedItems = [], freshItems = [], viewedIds = new Set(), trashIds = new Set() }) {
  const blocked = (item) => !item?.id || viewedIds.has(item.id) || trashIds.has(item.id);
  const freshById = new Map(freshItems.filter((item) => !blocked(item)).map((item) => [item.id, item]));
  const merged = [];
  const seen = new Set();

  for (const cached of cachedItems) {
    if (blocked(cached) || seen.has(cached.id)) continue;
    const fresh = freshById.get(cached.id);
    merged.push(fresh ? { ...cached, ...fresh } : cached);
    seen.add(cached.id);
  }
  for (const fresh of freshItems) {
    if (blocked(fresh) || seen.has(fresh.id)) continue;
    merged.push(fresh);
    seen.add(fresh.id);
  }
  return merged;
}

export function getRenderableImageUri(uri, allowRemote = false) {
  if (typeof uri !== 'string' || !uri || uri.startsWith('ph://')) return null;
  if (uri.startsWith('file://') || allowRemote) return uri;
  return null;
}

export function getPhotoKitPreviewUri({ isVideo, systemUri }) {
  if (isVideo || typeof systemUri !== 'string' || !systemUri.trim()) return null;
  if (systemUri.startsWith('file://') || systemUri.startsWith('http://') || systemUri.startsWith('https://')) return systemUri;
  return null;
}

export function getPhotoKitAssetRef(item) {
  const raw = item?.id || item?.uri;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  if (raw.startsWith('ph://') || raw.startsWith('assets-library://')) return raw;
  return `ph://${raw}`;
}

export function getEmptyPageStatus({ pageStatus, candidates, initialAssets, viewed, discoveryError = false, pendingCloud = 0, exhaustedCloud = 0 }) {
  if (!discoveryError && pageStatus === 'empty-library' && pendingCloud > 0) {
    return 'cloud-pending';
  }
  if (pageStatus === 'empty-library' && exhaustedCloud > 0) {
    return 'error';
  }
  if (!discoveryError && pageStatus === 'empty-library' && candidates === 0 && initialAssets > 0 && viewed > 0) {
    return 'all-viewed';
  }
  return pageStatus;
}

export async function collectUsablePage({ limit, nextCandidates, resolveCandidates, carryOver = [] }) {
  const target = Math.max(0, limit || 0);
  const items = Array.isArray(carryOver) ? carryOver.splice(0, target) : [];
  const diagnostics = {
    candidates: 0,
    local: items.length,
    cloud: 0,
    preview: 0,
    failed: 0,
  };
  let hasMore = true;
  let emptyBatchCount = 0;

  while (items.length < target && hasMore) {
    const batch = await nextCandidates(Math.max(target - items.length, 20));
    const candidates = Array.isArray(batch?.items) ? batch.items : [];
    hasMore = Boolean(batch?.hasMore);
    if (!candidates.length) {
      if (!hasMore || emptyBatchCount > 0) break;
      emptyBatchCount += 1;
      continue;
    }
    emptyBatchCount = 0;

    diagnostics.candidates += candidates.length;
    const resolved = await resolveCandidates(candidates);
    const usable = Array.isArray(resolved?.items) ? resolved.items : [];
    const remaining = Math.max(0, target - items.length);
    items.push(...usable.slice(0, remaining));
    if (Array.isArray(carryOver) && usable.length > remaining) {
      carryOver.push(...usable.slice(remaining));
    }
    const localCount = Number(resolved?.diagnostics?.local);
    const cloudCount = Number(resolved?.diagnostics?.cloud);
    const previewCount = Number(resolved?.diagnostics?.preview);
    const failedCount = Number(resolved?.diagnostics?.failed);
    diagnostics.local += Number.isFinite(localCount) ? localCount : usable.length;
    diagnostics.cloud += Number.isFinite(cloudCount) ? cloudCount : 0;
    diagnostics.preview += Number.isFinite(previewCount) ? previewCount : 0;
    diagnostics.failed += Number.isFinite(failedCount) ? failedCount : 0;
  }

  const pageItems = items.slice(0, target);
  const status = pageItems.length
    ? 'ready'
    : diagnostics.failed > 0 && diagnostics.candidates > 0
      ? 'error'
      : 'empty-library';
  return {
    items: pageItems,
    hasNextPage: hasMore || carryOver.length > 0,
    status,
    diagnostics: {
      ...diagnostics,
      returned: pageItems.length,
    },
  };
}

export function computeStorageImpactScore(unit) {
  if (!unit || !Array.isArray(unit?.items) || !unit.items.length) return 0;
  let totalScoreMB = 0;
  for (const item of unit.items) {
    if (!item) continue;
    let itemMB = 0;
    const knownBytes = item.fileSizeBytes || item.fileSize || 0;
    if (knownBytes > 0) {
      itemMB = knownBytes / (1024 * 1024);
    } else {
      if (item.mediaType === 'video') {
        const rawDuration = typeof item.duration === 'number' ? item.duration : 5;
        // Legacy expo-media-library reports seconds; the next API reports ms.
        const durationSec = Math.max(3, rawDuration > 600 ? rawDuration / 1000 : rawDuration);
        itemMB = Math.max(15, durationSec * 3);
      } else if (item.isLive) {
        itemMB = 8;
      } else {
        const megapixels = Math.max(1, ((item.width || 0) * (item.height || 0)) / 1_000_000);
        itemMB = Math.max(1, megapixels * 0.45);
      }
    }
    totalScoreMB += itemMB;
  }
  return totalScoreMB;
}

export function pruneReleasedBurstFrames(items, releasedIds) {
  if (!Array.isArray(items) || !releasedIds?.size) return items || [];
  return items.filter((item) => !releasedIds.has(item?.id));
}

export function sortAndShuffleByStorageImpact(units, shuffleFn = (arr) => arr.slice()) {
  if (!Array.isArray(units) || units.length <= 1) return units || [];
  const highImpact = [];
  const regular = [];

  for (const unit of units) {
    const score = computeStorageImpactScore(unit);
    if (score >= 20 || unit.items?.[0]?.mediaType === 'video' || (unit.items?.length || 0) > 1) {
      highImpact.push({ unit, score });
    } else {
      regular.push({ unit, score });
    }
  }

  // Shuffle within buckets so order remains fresh and surprise-filled
  const shuffledHigh = shuffleFn(highImpact.sort((a, b) => b.score - a.score)).map((entry) => entry.unit);
  const shuffledRegular = shuffleFn(regular).map((entry) => entry.unit);

  return [...shuffledHigh, ...shuffledRegular];
}

/**
 * Prefetch planner. The old behaviour (prefetch every frame of the next 6
 * entries on every page turn) turned a 20-frame burst deck plus a 100k-photo
 * catalog into a full-resolution decode/IO storm that fed the jetsam peak.
 * Now: a short entry window, and burst decks only prefetch their first
 * frames — the card itself slides the window as the user flips (PRD §9 lists
 * neighbouring preload as a legal degradation level).
 */
export function planFeedPrefetch(feed, activeIndex, { entryWindow = 3, framesPerEntry = 2 } = {}) {
  const uris = [];
  if (!Array.isArray(feed) || !feed.length) return uris;
  const start = Math.max(0, Math.floor(Number(activeIndex) || 0));
  const end = Math.min(start + Math.max(1, Math.floor(entryWindow) || 1), feed.length);
  const frameCap = Math.max(1, Math.floor(framesPerEntry) || 1);
  for (let i = start; i < end; i++) {
    const items = feed[i]?.unit?.items;
    if (!Array.isArray(items) || !items.length) continue;
    const cap = items.length > 1 ? Math.min(frameCap, items.length) : 1;
    for (let j = 0; j < cap; j++) {
      const u = items[j]?.displayUri || items[j]?.imageUri || items[j]?.uri || items[j]?.localUri;
      if (u) uris.push(u);
    }
  }
  return uris;
}

/**
 * Allocation-free local calendar-day key. `new Date(ts)` per asset over a
 * 100k catalog (fetchDayItems filtering) is a needless allocation storm; the
 * timezone offset is cached per 30-minute bucket so DST transitions are still
 * exact while photos taken in the same half hour share one lookup.
 */
const TZ_BUCKET_MS = 30 * 60 * 1000;
const tzOffsetCache = new Map();

export function getLocalDayKey(timestampMs) {
  const ts = Number(timestampMs);
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const bucket = Math.floor(ts / TZ_BUCKET_MS);
  let offset = tzOffsetCache.get(bucket);
  if (offset === undefined) {
    if (tzOffsetCache.size > 4096) tzOffsetCache.clear();
    offset = new Date(ts).getTimezoneOffset();
    tzOffsetCache.set(bucket, offset);
  }
  return String(Math.floor((ts - offset * 60000) / 86400000));
}

/**
 * Local-only GPS label. Remote geocoding was removed (PRD 3.10 zero
 * telemetry), which left the info panel without any location row — the
 * stored place fields are never populated. Raw coordinates restore the row
 * without any network call.
 */
export function formatGpsCoordinate(location) {
  const lat = Number(location?.latitude);
  const lon = Number(location?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '';
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return '';
  return `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? 'E' : 'W'}`;
}
