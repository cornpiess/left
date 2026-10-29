import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  AppState,
  FlatList,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Image as ExpoImage } from 'expo-image';
import * as MediaLibrary from 'expo-media-library/next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useIsFocused } from '@react-navigation/native';
import { colors, formatBytes } from '../theme';
import { getBrowseSession, openBrowseSession, retryBrowseSession, resetBrowseSession, persistBrowseSession, loadMoreNativeGroup, reconcileBrowseLibrary, clearViewedHistory, openDaySession, fetchDayPage, fetchMemoryPage, fetchTrashSummary, getShareUri, getTotalCleanedBytes, releaseUnviewedBurstFrames, restoreFromTrash, setRecommendMode, startBurstDiscovery, subscribeMediaUpdates, subscribePhotoLibraryChanges } from '../media';
import { planFeedPrefetch, pruneReleasedBurstFrames } from '../mediaPage.mjs';
import { experience, cleanup } from '../experience';
import useMediaWindow from '../useMediaWindow';
import useScrollLiveness from '../useScrollLiveness';
import { mergeDayWindow } from '../mediaWindow.mjs';
import { supportsNativePhotoPreview } from '../nativePhotoPreview';
import { isTrashAsset, mediaResources, getUnresolvedMediaCount } from '../media';
import { flightEvent, initFlightRecorder } from '../flightRecorder';
import { GlassPanel, JellyPressable } from '../components/Glass';
import TrashGallery from '../components/TrashGallery';
import MemoryCard, { silenceAllPlayers } from '../components/MemoryCard';
import MemoryInfoPanel from '../components/MemoryInfoPanel';
import DayMemoryCarousel from '../components/DayMemoryCarousel';
import VideoProgressControl from '../components/VideoProgressControl';
import MoreMenuModal from '../components/MoreMenuModal';
import PaywallModal from '../components/PaywallModal';
import SwipeCoachOverlay from '../components/SwipeCoachOverlay';
import useExperienceHints from '../useExperienceHints';
import { getMembershipState, initMembership, subscribeMembership, DAILY_FREE_LIMIT } from '../membership';
import MaoQiuIcon from '../components/MaoQiuIcon';
import { buildRatingPromptStateAfterAction, shouldOfferRatingPrompt } from '../ratingPrompt.mjs';
import { loadRatingPromptState, openAppStoreReview, saveRatingPromptState } from '../ratingStore';

import { useI18n } from '../i18n';

const PAGE_SIZE = 50;
const EMPTY_LIBRARY_RETRY_LIMIT = 3;
// How many entries the user must walk past a burst deck before its unviewed
// frames are released back into the feed as independent cards. Inside this
// buffer the deck stays intact for 回看 (swipe-down review).
const BURST_RELEASE_BUFFER_CARDS = 5;
// Prefetch window: 3 entries ahead, burst decks capped at their first 2
// frames (the card itself slides its own window while flipping). The old
// "next 6 entries × every frame" storm fed the jetsam peak on 100k-photo
// libraries and starved the decoding budget of on-screen cards.
const PREFETCH_ENTRY_WINDOW = 3;
const PREFETCH_FRAMES_PER_ENTRY = 2;
const RETRY_ENTRY = { key: '__feed-retry__', kind: 'retry', unit: { items: [] } };
const COMPLETION_ENTRY = { key: '__feed-complete__', kind: 'complete', unit: { items: [] } };

const BottomControls = memo(function BottomControls({ bottom, summary, canUndo, onShare, onOpenTrash, onUndo }) {
  const { t } = useI18n();
  const maoqiuName = t('common.maoqiu');
  const label = summary.count
    ? summary.calculating
      ? `${maoqiuName} ${summary.count} · ${t('common.loading')}`
      : `${maoqiuName} ${summary.count} · ${summary.unknownCount ? '≈ ' : ''}${formatBytes(summary.sizeBytes)}`
    : maoqiuName;
  return (
    <View style={[styles.trashCapWrap, { bottom }]} pointerEvents="box-none">
      {/* 1. Share button (Left bottom, left: 18) */}
      <View style={styles.bottomLeftSlot} pointerEvents="box-none">
        <JellyPressable onPress={onShare} hitSlop={8}>
          <GlassPanel style={styles.bottomRoundPanel} radius={23} intensity={62}>
            <Ionicons name="share-outline" size={20} color={colors.white} />
          </GlassPanel>
        </JellyPressable>
      </View>

      {/* 2. MaoQiu capsule button (Center bottom) */}
      <View style={styles.bottomCenterSlot} pointerEvents="box-none">
        <JellyPressable onPress={onOpenTrash} hitSlop={8}>
          <GlassPanel style={styles.trashCap} radius={23} intensity={62}>
            <MaoQiuIcon size={29} color={colors.white} />
            <Text style={styles.trashCapText}>{label}</Text>
          </GlassPanel>
        </JellyPressable>
      </View>

      {/* 3. Undo button (Right bottom, right: 16) */}
      <View style={styles.bottomRightSlot} pointerEvents="box-none">
        {canUndo ? (
          <JellyPressable onPress={onUndo} hitSlop={8}>
            <GlassPanel style={styles.bottomRoundPanel} radius={23} intensity={62}>
              <Ionicons name="arrow-undo" size={20} color={colors.white} />
            </GlassPanel>
          </JellyPressable>
        ) : null}
      </View>
    </View>
  );
});

export default function HomeScreen({ accessPrivileges = 'all' }) {
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();
  const { width: viewportWidth, height: viewportHeight } = useWindowDimensions();
  const isLandscape = viewportWidth > viewportHeight;
  const { t } = useI18n();

  const [feed, setFeed] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadStatus, setLoadStatus] = useState('loading');
  const [loadError, setLoadError] = useState(null);
  const [feedComplete, setFeedComplete] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [listH, setListH] = useState(0);
  const [toast, setToast] = useState(null);
  const [emptyRetryCount, setEmptyRetryCount] = useState(0);
  const [scrolling, setScrolling] = useScrollLiveness();
  const [cardZoomed, setCardZoomed] = useState(false);
  const [cardHorizontalGestureActive, setCardHorizontalGestureActive] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [undoTrash, setUndoTrash] = useState(null);
  const [activeVideoPlayer, setActiveVideoPlayer] = useState(null);
  const [dayBrowse, setDayBrowse] = useState(null);
  const [dayWindowIndex, setDayWindowIndex] = useState(0);
  const [dayScrolling, setDayScrolling] = useScrollLiveness();
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [paywallOpen, setPaywallOpen] = useState(false);
  const { hint, learn: learnHint, shown: photoShown } = useExperienceHints();
  const [paywallReason, setPaywallReason] = useState('menu');
  const [membership, setMembership] = useState(getMembershipState());
  const [trashSummary, setTrashSummary] = useState({ count: 0, sizeBytes: 0, unknownCount: 0, calculating: false });
  const [ratingState, setRatingState] = useState(null);

  const [appActive, setAppActive] = useState(true);
  const journeyRef = useRef({ startedAt: Date.now(), firstPhoto: false, firstSelection: false });

  // App Store rating invitation state: loaded once; mutated only by explicit
  // user taps on the completion-page card.
  useEffect(() => {
    loadRatingPromptState().then(setRatingState).catch(() => {});
  }, []);

  // Local-only flight recorder (no telemetry, PRD 3.10): milestones + session
  // lifecycle persisted to AsyncStorage so the NEXT launch after a native
  // kill (jetsam/watchdog) can show what the app was doing when it died.
  useEffect(() => {
    initFlightRecorder();
  }, []);

  useEffect(() => {
    void initMembership();
    const unsub = subscribeMembership((state) => {
      setMembership(state);

    });
    return unsub;
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      setAppActive(nextState === 'active');
      if (nextState === 'active') setMembership(getMembershipState());
    });
    return () => sub.remove();
  }, []);

  const listRef = useRef(null);
  const listHeightRef = useRef(listH);
  listHeightRef.current = listH;
  const rawAssetsRef = useRef([]);
  const nextCursorRef = useRef(null);
  const hasNextPageRef = useRef(true);
  const pageLoadingRef = useRef(false);
  const mediaUpdatePendingRef = useRef(false);
  const feedRef = useRef([]);
  const activeIndexRef = useRef(0);
  const previousActiveIndexRef = useRef(0);
  const burstPosRef = useRef(new Map());
  const loadGenerationRef = useRef(0);
  const nextWindowItems = useMemo(() => {
    if (trashOpen || moreMenuOpen || paywallOpen) return [];
    if (dayBrowse) return dayBrowse.items.slice(dayWindowIndex + 1, dayWindowIndex + 3);
    const entry = feed[activeIndex];
    const position = entry ? burstPosRef.current.get(entry.key) || 0 : 0;
    const sameGroup = entry?.unit.items.slice(position + 1, position + 3) || [];
    return [...sameGroup, ...feed.slice(activeIndex + 1, activeIndex + 3).map(e => e.unit.items[0])].slice(0, 2);
  }, [feed, activeIndex, dayBrowse, dayWindowIndex, trashOpen, moreMenuOpen, paywallOpen]);
  const constrained = useMediaWindow({ nextItems: nextWindowItems,
    width: dayBrowse ? Math.round(Math.min(viewportWidth, viewportHeight) * 0.75) : viewportWidth - 12,
    height: dayBrowse ? Math.round(Math.max(viewportWidth, viewportHeight) * 0.72) : listH,
    interactive: dayBrowse ? dayScrolling : scrolling || cardHorizontalGestureActive,
    enabled: appActive && isFocused,
  });

  const landscapeRef = useRef(isLandscape);
  const restorePortraitRef = useRef(false);
  const burstDiscoveryStartedRef = useRef(false);
  const advanceLockRef = useRef(false);
  const settleTimerRef = useRef(null);
  const scrollOffsetRef = useRef(0);
  const toastAnim = useRef(new Animated.Value(0)).current;
  const toastTimer = useRef(null);

  useEffect(() => {
    feedRef.current = feed;
  }, [feed]);

  const showToast = useCallback(
    (msg, kind = 'default') => {
      setToast({ text: msg, kind });
      clearTimeout(toastTimer.current);
      toastAnim.setValue(0);
      Animated.spring(toastAnim, { toValue: 1, useNativeDriver: true, friction: 7 }).start();
      toastTimer.current = setTimeout(() => {
        Animated.timing(toastAnim, {
          toValue: 0,
          duration: 220,
          useNativeDriver: true,
        }).start(() => setToast(null));
      }, 1500);
    },
    [toastAnim]
  );

  const makeFeed = useCallback((assets) => {
    const session = getBrowseSession();
    session.reconcile(assets);
    return session.feed(new Set(assets.filter(item => isTrashAsset(item.id)).map(item => item.id)));
  }, []);

  /**
   * Rebuild the feed while keeping the user anchored on whatever they are
   * currently viewing. Every mid-session rebuild (restore, burst release)
   * must go through here. Stable group identities survive edits; filtering
   * pending/missing members may still shift display indices.
   */
  const rebuildFeedPreservingPosition = useCallback(() => {
    const prevFeed = feedRef.current;
    const prevIdx = activeIndexRef.current;
    const prevEntry = prevFeed[prevIdx];
    const anchorId = prevEntry
      ? (prevEntry.unit.items[burstPosRef.current.get(prevEntry.key) || 0] || prevEntry.unit.items[0])?.id
      : null;
    const nextFeed = makeFeed(rawAssetsRef.current);
    feedRef.current = nextFeed;
    setFeed(nextFeed);
    const blocked = new Set(rawAssetsRef.current.filter(item => isTrashAsset(item.id)).map(item => item.id));
    const fallback = getBrowseSession().restoreAnchor(blocked);
    const selectedId = nextFeed.some(entry => entry.unit.items.some(item => item.id === anchorId)) ? anchorId : fallback;
    const found = nextFeed.findIndex(entry => entry.unit.items.some(item => item.id === selectedId));
    const target = found >= 0 ? found : Math.min(prevIdx, Math.max(0, nextFeed.length - 1));
    const entry = nextFeed[target];
    if (!entry) { activeIndexRef.current = 0; setActiveIndex(0); return; }
    const pos = entry.unit.items.findIndex(candidate => candidate.id === selectedId);
    if (pos >= 0) burstPosRef.current.set(entry.key, pos);
    if (target !== prevIdx) {
      activeIndexRef.current = target;
      setActiveIndex(target);
      if (listH > 0) {
        scrollOffsetRef.current = target * listH;
        listRef.current?.scrollToOffset({ offset: target * listH, animated: false });
      }
    }
  }, [makeFeed, listH]);

  const loadInitial = useCallback(async (options = {}) => {
    const token = ++loadGenerationRef.current;
    pageLoadingRef.current = true;
    const startedAt = Date.now();
    setFeedComplete(false);
    setLoadError(null);
    if (!feedRef.current.length || options.discardCurrentFeed) { setLoading(true); setLoadStatus('loading'); }
    burstDiscoveryStartedRef.current = false;
    try {
      if (options.discardCurrentFeed) {
        experience.reset();
        await resetBrowseSession();
        if (token !== loadGenerationRef.current) return;
        setDayBrowse(null); daySessionRef.current = null;
        rawAssetsRef.current = []; feedRef.current = []; setFeed([]);
        burstPosRef.current.clear();
      }
      const session = await (options.retry ? retryBrowseSession() : openBrowseSession());
      if (token !== loadGenerationRef.current) return;
      const adopt = () => {
        rawAssetsRef.current = session.state.entries.flatMap(entry => entry.unit.items);
        const next = session.feed(new Set(rawAssetsRef.current.filter(item => isTrashAsset(item.id)).map(item => item.id)));
        const anchor = session.restoreAnchor(new Set(rawAssetsRef.current.filter(item => isTrashAsset(item.id)).map(item => item.id)));
        const index = Math.max(0, next.findIndex(entry => entry.unit.items.some(item => item.id === anchor)));
        for (const entry of next) {
          const id = entry.unit.items.some(item => item.id === anchor) ? anchor : session.state.positions[entry.key];
          const pos = entry.unit.items.findIndex(item => item.id === id);
          burstPosRef.current.set(entry.key, Math.max(0, pos));
        }
        feedRef.current = next; activeIndexRef.current = index;
        previousActiveIndexRef.current = index;
        setFeed(next); setActiveIndex(index);
        if (next.length) { setLoading(false); setLoadStatus('ready'); }
        const height = listHeightRef.current;
        if (height > 0) requestAnimationFrame(() => {
          scrollOffsetRef.current = index * height;
          listRef.current?.scrollToOffset({ offset: index * height, animated: false });
        });
      };
      adopt();
      if (session.state.day?.items?.length) {
        const day = session.state.day;
        const dayItems = day.items.filter(item => !isTrashAsset(item.id)).map(item => ({
          ...item, previewUri: 'ph://' + item.id, ...(item.mediaType === 'video' ? { displayUri: 'ph://' + item.id } : {}),
        }));
        const initialIndex = Math.max(0, dayItems.findIndex(item => item.id === day.anchorId));
        const anchor = dayItems[initialIndex];
        if (anchor) {
          const pager = openDaySession(anchor);
          pager.reset('before', dayItems[0]); pager.reset('after', dayItems.at(-1));
          daySessionRef.current = pager;
          dayBrowseAnchorIndexRef.current = activeIndexRef.current;
          setDayWindowIndex(initialIndex);
          setDayBrowse({ items: dayItems, initialIndex, loading: false, hasBefore: true, hasAfter: true });
        }
      }
      nextCursorRef.current = 'next'; hasNextPageRef.current = true;
      const visibleAhead = feedRef.current.length - activeIndexRef.current - 1;
      if (visibleAhead < 2) {
        const page = await fetchMemoryPage(PAGE_SIZE, 'next');
        if (token !== loadGenerationRef.current || page.stale) return;
        nextCursorRef.current = page.endCursor; hasNextPageRef.current = page.hasNextPage;
        adopt();
        setLoadStatus(feedRef.current.length ? 'ready' : page.status);
        setFeedComplete(!page.hasNextPage && page.status !== 'error' && page.status !== 'empty-library');
      }
      await persistBrowseSession();
    } catch (error) {
      if (token !== loadGenerationRef.current) return;
      setLoadError(error); setLoadStatus('error');
      flightEvent('load-initial-failed', { stage: error?.photoLoadStage || 'home-adopt', message: error?.message || 'unknown' });
    } finally {
      if (token === loadGenerationRef.current) {
        pageLoadingRef.current = false; setLoading(false);
        flightEvent('load-initial-done', Date.now() - startedAt);
      }
    }
  }, [accessPrivileges, makeFeed]);

  const retryLoad = useCallback(() => {
    if (pageLoadingRef.current) return;
    setEmptyRetryCount(0);
    return loadInitial({ retry: true });
  }, [loadInitial]);

  useEffect(() => { void loadInitial(); }, [loadInitial]);

  const loadNextPage = useCallback(async () => {
    if (pageLoadingRef.current || !hasNextPageRef.current || !nextCursorRef.current) return;
    if (feedRef.current.length - activeIndexRef.current - 1 >= 2) return;
    pageLoadingRef.current = true;
    const owner = getBrowseSession();
    try {
      const page = await fetchMemoryPage(PAGE_SIZE, nextCursorRef.current);
      if (owner !== getBrowseSession() || page.stale) return;
      nextCursorRef.current = page.endCursor; hasNextPageRef.current = page.hasNextPage;
      rawAssetsRef.current = owner.state.entries.flatMap(entry => entry.unit.items);
      const next = owner.feed(new Set(rawAssetsRef.current.filter(item => isTrashAsset(item.id)).map(item => item.id)));
      feedRef.current = next; setFeed(next);
      setLoadStatus(next.length ? 'ready' : page.status);
      setFeedComplete(!page.hasNextPage && page.status !== 'error' && page.status !== 'empty-library');
      if (!page.items.length && page.hasNextPage) mediaUpdatePendingRef.current = true;
    } catch (err) {
      console.warn('[HomeScreen] loadNextPage failed:', err?.message || err);
      setLoadStatus('error'); flightEvent('page-failed', err?.message || 'unknown');
    } finally { pageLoadingRef.current = false; }
  }, []);

  useEffect(() => {
    if (loading || feed.length || loadStatus !== 'loading' || !hasNextPageRef.current) return;
    const timer = setTimeout(() => { void loadNextPage(); }, 80);
    return () => clearTimeout(timer);
  }, [loading, feed, loadStatus, loadNextPage]);

  const refreshAssetInFeed = useCallback((asset) => {
    if (!asset?.id) return;
    getBrowseSession().refresh(asset);
    const index = rawAssetsRef.current.findIndex((candidate) => candidate.id === asset.id);
    if (index < 0) return;
    rawAssetsRef.current[index] = asset;
    const nextFeed = makeFeed(rawAssetsRef.current);
    feedRef.current = nextFeed;
    setFeed(nextFeed);
  }, [makeFeed]);

  useEffect(() => subscribeMediaUpdates((event) => {
    if (event?.type === 'browse-reconciled') {
      const session = getBrowseSession();
      rawAssetsRef.current = session.state.entries.flatMap(entry => entry.unit.items);
      rebuildFeedPreservingPosition();
      setDayBrowse(previous => previous && session.state.day
        ? { ...previous, items: session.state.day.items.filter(item => !isTrashAsset(item.id)) } : previous);
      return;
    }
    if (event?.type === 'media-display-failed') { setLoadStatus('error'); return; }
    if (event?.type === 'operation-failed') {
      void loadInitial();
      return;
    }
    if (event?.type === 'asset-ready') {
      refreshAssetInFeed(event.asset);
      return;
    }
    if (event?.type === 'library-reload-required' || (event?.type === 'catalog-ready' && !feedRef.current.length && !pageLoadingRef.current)) {
      flightEvent('feed-reload', event?.type);
      void reconcileBrowseLibrary().then(() => {
        rawAssetsRef.current = getBrowseSession().state.entries.flatMap(entry => entry.unit.items);
        rebuildFeedPreservingPosition();
      }).catch(error => { setLoadStatus('error'); flightEvent('library-reconcile', error?.message || 'failed'); });
      return;
    }
    if (event?.type === 'library-inserted') {
      setFeedComplete(false);
      hasNextPageRef.current = true;
      nextCursorRef.current = 'next';
    }
    if (pageLoadingRef.current) {
      mediaUpdatePendingRef.current = true;
      return;
    }
    if (hasNextPageRef.current && nextCursorRef.current) {
      void loadNextPage();
    }
  }), [loadNextPage, refreshAssetInFeed, loadInitial]);

  useEffect(() => subscribePhotoLibraryChanges(), []);

  // "打开必有照片" 安全网。首次授权后（或清空已读历史后），PhotoKit 目录可能
  // 仍在就绪中而瞬间返回空结果。此时绝不能立刻判定"没有可访问的照片"——
  // 先以"正在准备照片"状态自动重试几次，最后一次仍为空才给出最终空态判定。
  useEffect(() => {
    if (loading || pageLoadingRef.current) return undefined;
    if (feed.length || rawAssetsRef.current.length) {
      if (emptyRetryCount !== 0) setEmptyRetryCount(0);
      return undefined;
    }
    if (loadStatus !== 'empty-library') return undefined;
    if (emptyRetryCount >= EMPTY_LIBRARY_RETRY_LIMIT) return undefined;
    const attempt = emptyRetryCount + 1;
    const timer = setTimeout(() => {
      setEmptyRetryCount(attempt);
      void loadInitial({ retry: true });
    }, 1000 * attempt);
    return () => clearTimeout(timer);
  }, [loadStatus, loading, feed, loadInitial, emptyRetryCount]);

  useEffect(() => {
    if (!loading && mediaUpdatePendingRef.current && !pageLoadingRef.current && hasNextPageRef.current && nextCursorRef.current) {
      mediaUpdatePendingRef.current = false;
      void loadNextPage();
    }
  }, [loading, loadNextPage]);

  const managePhotoAccess = useCallback(async () => {
    try {
      await MediaLibrary.presentPermissionsPicker(['photo']);
      await reconcileBrowseLibrary();
      await loadInitial();
    } catch (error) {
      console.warn('[home] photo access picker failed:', error?.message || error);
      setLoadError(error);
      setLoadStatus('error');
    }
  }, [loadInitial]);

  useEffect(() => {
    if (feed.length - activeIndex <= 3) void loadNextPage();
  }, [activeIndex, feed.length, loadNextPage]);

  useEffect(() => {
    // Decks are released only after the user has walked BURST_RELEASE_BUFFER_CARDS
    // entries past them: the immediate 回看 window keeps the deck intact, and
    // the release rebuild happens well off-screen so the deck never collapses
    // with a visible flicker (the "burst suddenly disappears" bug).
    if (activeIndex > previousActiveIndexRef.current) {
      let releasedAny = false;
      const scanFrom = Math.max(0, activeIndex - BURST_RELEASE_BUFFER_CARDS - 4);
      for (let i = scanFrom; i < activeIndex; i += 1) {
        const deckEntry = feed[i];
        if (!deckEntry || deckEntry.unit.items.length < 2) continue;
        if (activeIndex - i < BURST_RELEASE_BUFFER_CARDS) continue;
        const lastPos = burstPosRef.current.get(deckEntry.key) || 0;
        const lastSeenId = deckEntry.unit.items[lastPos]?.id;
        const releasedIds = releaseUnviewedBurstFrames(deckEntry.unit.items, lastSeenId);
        if (releasedIds.size) {
          rawAssetsRef.current = pruneReleasedBurstFrames(rawAssetsRef.current, releasedIds);
          releasedAny = true;
        }
      }
      if (releasedAny) rebuildFeedPreservingPosition();
    }
    previousActiveIndexRef.current = activeIndex;

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex, feed, rebuildFeedPreservingPosition]);

  const handleResetViewedHistory = useCallback(async () => {
    experience.reset();
    await clearViewedHistory();
    setActiveIndex(0);
    activeIndexRef.current = 0;
    try {
      listRef.current?.scrollToIndex({ index: 0, animated: false });
    } catch {}
    showToast(t('menu.resetHistorySuccess'));
    setMoreMenuOpen(false);
    await loadInitial({ discardCurrentFeed: true });
  }, [loadInitial, showToast, t]);

  // Rating invitation: only success consumes the automatic prompt — a failed
  // launch must not lock the user out of a future attempt.
  const handleRateApp = useCallback(async () => {
    const opened = await openAppStoreReview();
    if (!opened) {
      showToast(t('rating.toastFailed'));
      return;
    }
    setRatingState((prev) => {
      const next = buildRatingPromptStateAfterAction(prev, 'rated');
      saveRatingPromptState(next);
      return next;
    });
  }, [showToast, t]);

  const handleRateLater = useCallback(() => {
    setRatingState((prev) => {
      const next = buildRatingPromptStateAfterAction(prev, 'later');
      saveRatingPromptState(next);
      return next;
    });
  }, []);

  // Multi-card proactive prefetch pipeline (like TikTok / Instagram Reels):
  // a short entry window is prefetched in the background so scrolling down
  // stays instant. Window size is bounded (see PREFETCH_* above) — prefetching
  // every frame of every upcoming entry used to storm full-resolution decodes
  // and starve the on-screen cards on huge libraries.
  useEffect(() => {
    if (supportsNativePhotoPreview || scrolling || !appActive || !feed.length) return;
    planFeedPrefetch(feed, activeIndex, {
      entryWindow: PREFETCH_ENTRY_WINDOW,
      framesPerEntry: PREFETCH_FRAMES_PER_ENTRY,
    }).forEach((uri) => {
      try {
        ExpoImage.prefetch(uri);
      } catch {}
    });
  }, [activeIndex, feed, scrolling, appActive]);

  const handleRecommendModeChange = useCallback(async (mode) => {
    await setRecommendMode(mode);
    await loadInitial({ discardCurrentFeed: true });
    showToast(mode === 'storage' ? t('menu.recommendStorage') : t('menu.recommendDefault'));
  }, [loadInitial, showToast, t]);

  const handleVideoPlayerChange = useCallback(({ id, player, live }) => {
    setActiveVideoPlayer((current) => {
      if (!player) return current?.id === id ? null : current;
      if (current?.id === id && current.player === player) return current;
      return { id, player, live: !!live };
    });
  }, []);

  const handleHorizontalGestureChange = useCallback((active) => {
    setCardHorizontalGestureActive((current) => (current === active ? current : active));
  }, []);

  const startBurstDiscoveryOnce = useCallback(() => {
    if (burstDiscoveryStartedRef.current) return;
    burstDiscoveryStartedRef.current = true;
    void startBurstDiscovery();
  }, []);

  const handleShareCurrent = useCallback(async () => {
    const entry = feedRef.current[activeIndexRef.current];
    const position = entry ? burstPosRef.current.get(entry.key) || 0 : 0;
    const item = entry?.unit.items[position] || entry?.unit.items[0];
    if (!item) return;
    try {
      const uri = await getShareUri(item);
      if (uri) await Share.share({ url: uri, message: item.filename || t('home.shareFallback') });
    } catch {}
  }, [t]);

  // Resume playback only after the viewport has settled. The snapped page is
  // resolved DETERMINISTICALLY from the scroll offset (not from the async
  // viewability callback, which can leave activeIndex stale when the pager
  // rests between two cards below the visibility threshold — that stale card
  // would keep playing audio over the next photo).
  const scheduleUnlock = useCallback(() => {
    clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(() => {
      if (listH > 0) {
        const idx = Math.round(scrollOffsetRef.current / listH);
        const pendingEntry = feedRef.current[idx];
        const pendingItem = pendingEntry?.unit.items[burstPosRef.current.get(pendingEntry.key) || 0];
        if (pendingItem && getBrowseSession().settle(pendingItem.id)) {
          rawAssetsRef.current = getBrowseSession().state.entries.flatMap(entry => entry.unit.items);
          const next = getBrowseSession().feed(new Set(rawAssetsRef.current.filter(i => isTrashAsset(i.id)).map(i => i.id)));
          feedRef.current = next; setFeed(next);
        }
        const renderedLength = feedRef.current.length + (feedComplete ? 1 : 0);
        if (idx >= 0 && idx < renderedLength && idx !== activeIndexRef.current) {
          activeIndexRef.current = idx;
          silenceAllPlayers();
          setActiveIndex(idx);
        }
      }
      setScrolling(false);
    }, 16);
  }, [feedComplete, listH]);

  const dayBrowseAnchorIndexRef = useRef(0);
  const daySessionRef = useRef(null);
  const dayLoadRef = useRef(new Set());

  const enterDayBrowse = useCallback(
    async (anchor) => {
      if (!anchor || dayBrowse) return;
      // Record the exact main feed index where the user pinched in!
      dayBrowseAnchorIndexRef.current = activeIndexRef.current;

      if (activeVideoPlayer?.player) {
        try {
          activeVideoPlayer.player.muted = true;
          activeVideoPlayer.player.pause();
        } catch {}
        setActiveVideoPlayer(null);
      }
      setScrolling(true);
      setDayWindowIndex(0);
      setDayBrowse({ items: [anchor], initialIndex: 0, loading: true });
      try {
        const session = openDaySession(anchor);
        daySessionRef.current = session;
        const before = await fetchDayPage(session, 'before');
        const after = await fetchDayPage(session, 'after');
        if (daySessionRef.current !== session) return;
        const items = [...before, anchor, ...after];
        const initialIndex = before.length;
        setDayWindowIndex(initialIndex);
        setDayBrowse({ items, initialIndex, loading: false, hasBefore: session.more('before'), hasAfter: session.more('after') });
      } catch {
        setDayBrowse(null);
        setScrolling(false);
      }
    },
    [dayBrowse, makeFeed, activeVideoPlayer]
  );

  const loadDaySide = useCallback(async side => {
    const session = daySessionRef.current;
    if (!session?.next || dayLoadRef.current.size > 0 || !session.more(side)) return;
    dayLoadRef.current.add(side);
    try {
      const additions = await fetchDayPage(session, side);
      if (daySessionRef.current !== session) return;
      setDayBrowse(previous => {
        if (!previous) return previous;
        const merged = mergeDayWindow(previous.items, additions, side);
        if (merged.resetSide) {
          session.forget(merged.dropped.map(item => item.id));
          session.reset(merged.resetSide, merged.resetSide === 'before' ? merged.items[0] : merged.items[merged.items.length - 1]);
        }
        return { ...previous, items: merged.items, hasBefore: session.more('before'), hasAfter: session.more('after') };
      });
    } catch { showToast(t('home.toastMoveFailed')); }
    finally { dayLoadRef.current.delete(side); }
  }, [showToast, t]);
  const loadDayBefore = useCallback(() => { void loadDaySide('before'); }, [loadDaySide]);
  const loadDayAfter = useCallback(() => { void loadDaySide('after'); }, [loadDaySide]);

  const exitDayBrowse = useCallback(
    () => {
      if (activeVideoPlayer?.player) {
        try {
          activeVideoPlayer.player.muted = true;
          activeVideoPlayer.player.pause();
        } catch {}
        setActiveVideoPlayer(null);
      }
      daySessionRef.current = null;
      getBrowseSession().leaveDay();
      void persistBrowseSession().catch(() => {});
      setDayBrowse(null);

      // ALWAYS return to the exact main feed card where the user originally pinched in!
      const mainId = getBrowseSession().state.anchorId;
      const anchored = feedRef.current.findIndex(entry => entry.unit.items.some(item => item.id === mainId));
      const targetIndex = anchored >= 0 ? anchored : Math.min(
        Math.max(dayBrowseAnchorIndexRef.current, 0), Math.max(feedRef.current.length - 1, 0));

      activeIndexRef.current = targetIndex;
      setActiveIndex(targetIndex);
      setScrolling(true);

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (listRef.current && listH > 0) {
            try {
              listRef.current.scrollToOffset({ offset: targetIndex * listH, animated: false });
            } catch {}
          }
          scheduleUnlock();
        });
      });
    },
    [listH, scheduleUnlock, activeVideoPlayer]
  );

  useEffect(() => () => clearTimeout(settleTimerRef.current), []);

  const refreshTrashSummary = useCallback(async (showCalculating = false) => {
    if (showCalculating) setTrashSummary((prev) => ({ ...prev, calculating: true }));
    try {
      const { items, count, sizeBytes, unknownCount } = await fetchTrashSummary({ limit: 0 });
      const exactCount = typeof count === 'number' ? count : trashSummary.count;
      setTrashSummary((prev) => ({ ...prev, count: exactCount, sizeBytes, unknownCount, calculating: false }));
    } catch {
      setTrashSummary((prev) => ({ ...prev, count: trashSummary.count, calculating: false }));
    }
  }, []);

  useEffect(() => {
    refreshTrashSummary(true);
  }, [refreshTrashSummary]);

  // Persist the single shared decision before either view animates/removes it.
  const prepareTrash = useCallback(async (item) => {
    try {
      const session = getBrowseSession();
      if (dayBrowse) session.enterDay(dayBrowse.items, item.id, session.state.anchorId);
      else session.anchor(item.id);
      const result = await cleanup.select(item);
      if (!result.allowed) {
        if (result.reason === 'quota') { silenceAllPlayers(); setPaywallReason('quota'); setPaywallOpen(true); }
        return false;
      }
      if (!journeyRef.current.firstSelection) {
        journeyRef.current.firstSelection = true;
        flightEvent('first-cleanup-selection', Date.now() - journeyRef.current.startedAt);
      }
      return true;
    } catch {
      showToast(t('home.toastMoveFailed'));
      return false;
    }
  }, [showToast, t, dayBrowse]);

  const handleTrash = useCallback(
    (entry, selectedItem) => {
      learnHint('select');
      const pos = burstPosRef.current.get(entry.key) || 0;
      const cur = selectedItem || entry.unit.items[pos] || entry.unit.items[0];
      const idx = feedRef.current.findIndex((e) => e.key === entry.key);
      if (!cur || idx < 0) return;

      // Burst-only: count how many frames remain in this burst after we
      // remove the current one. If any are left, stay on the card and just
      // advance to the next frame — only scroll when the burst is gone.
      const wasBurst = entry.unit.items.length > 1;
      const remainingInBurst = wasBurst
        ? entry.unit.items.filter((i) => i.id !== cur.id && !isTrashAsset(i.id)).length
        : 0;

      const rawIndex = rawAssetsRef.current.findIndex((item) => item.id === cur.id);
      setUndoTrash({ item: cur, rawIndex });
      showToast(t('home.toastMovedToMaoqiu'));
      refreshTrashSummary();

      // The trashed asset STAYS in rawAssetsRef — makeFeed filters by
      // the shared pending state, so trash/restore have a single source and a
      // gallery restore can bring the photo back by id (ISSUE-002).
      if (wasBurst && remainingInBurst > 0) {
        const nextFeed = makeFeed(rawAssetsRef.current);
        feedRef.current = nextFeed;
        setFeed(nextFeed);
        const nextEntry = nextFeed[idx];
        if (nextEntry && nextEntry.unit.items.length > 1) {
          burstPosRef.current.set(nextEntry.key, Math.min(pos, nextEntry.unit.items.length - 1));
        }
        setScrolling(false);
        return;
      }

      const nextFeed = makeFeed(rawAssetsRef.current);
      feedRef.current = nextFeed;
      setFeed(nextFeed);
      const target = Math.min(idx, Math.max(nextFeed.length - 1, 0));
      if (nextFeed.length > 0) {
        activeIndexRef.current = target;
        setActiveIndex(target);
        scrollOffsetRef.current = target * listH;
        listRef.current?.scrollToOffset({ offset: target * listH, animated: false });
      } else {
        loadNextPage();
      }
      setScrolling(false);
    },
    [showToast, listH, loadNextPage, makeFeed, refreshTrashSummary, t, learnHint]
  );

  const handleUndoTrash = useCallback(() => {
    if (!undoTrash) return;
    const { item } = undoTrash;
    restoreFromTrash(item, { focus: true });
    if (!rawAssetsRef.current.some(candidate => candidate.id === item.id)) rawAssetsRef.current.push(item);
    // The asset never left rawAssetsRef; clearing the trash id above is the
    // whole state change, the rebuild brings it back at its original slot.
    const nextFeed = makeFeed(rawAssetsRef.current);
    feedRef.current = nextFeed;
    setFeed(nextFeed);
    const target = nextFeed.findIndex((entry) => entry.unit.items.some((candidate) => candidate.id === item.id));
    if (target >= 0) {
      const entry = nextFeed[target];
      const burstIndex = entry.unit.items.findIndex((candidate) => candidate.id === item.id);
      if (burstIndex >= 0) burstPosRef.current.set(entry.key, burstIndex);
      activeIndexRef.current = target;
      setActiveIndex(target);
      setScrolling(true);
      requestAnimationFrame(() => {
        scrollOffsetRef.current = target * listH;
        listRef.current?.scrollToOffset({ offset: target * listH, animated: false });
        scheduleUnlock();
      });
    }
    setUndoTrash(null);
    showToast(t('home.toastRestored'), 'undo');
    refreshTrashSummary();
  }, [undoTrash, listH, makeFeed, refreshTrashSummary, scheduleUnlock, showToast, t]);

  const openTrash = useCallback(() => {
    silenceAllPlayers();
    setTrashOpen(true);
  }, []);

  const handleDayTrash = useCallback(
    (item) => {
      if (!item) {
        showToast(t("home.toastMoveFailed"));
        return;
      }
      try {
        if (activeVideoPlayer?.player) {
          try {
            activeVideoPlayer.player.muted = true;
            activeVideoPlayer.player.pause();
          } catch {}
          setActiveVideoPlayer(null);
        }
        setCardZoomed(false);

        // 1. Immediately record in global trash sets (imperative ref - 100% thread-safe!)
        setUndoTrash({ item });

        // 2. Rebuild main feed (trashed asset stays in rawAssetsRef; makeFeed
        // filters by shared pending state — single source of truth)
        const nextFeed = makeFeed(rawAssetsRef.current);
        feedRef.current = nextFeed;
        setFeed(nextFeed);

        // 4. Update dayBrowse state using functional updater (prev => ...) to eliminate stale closure race conditions!
        setDayBrowse((prev) => {
          if (!prev || !prev.items) return null;
          const remaining = prev.items.filter((candidate) => candidate.id !== item.id);
          if (remaining.length === 0) {
            const target = Math.min(activeIndexRef.current, Math.max(nextFeed.length - 1, 0));
            if (target >= 0) {
              activeIndexRef.current = target;
              setActiveIndex(target);
              setScrolling(true);
              requestAnimationFrame(() => {
                scrollOffsetRef.current = target * listH;
                listRef.current?.scrollToOffset({ offset: target * listH, animated: false });
                scheduleUnlock();
              });
            } else {
              setScrolling(false);
            }
            return null;
          }
          return { ...prev, items: remaining };
        });

        learnHint('select');
        showToast(t('home.toastMovedToMaoqiu'));
        refreshTrashSummary();
      } catch (err) {
        console.error('[handleDayTrash] Exception:', err);
        showToast(t("home.toastMoveFailed"));
      }
    },
    [activeVideoPlayer, listH, makeFeed, refreshTrashSummary, scheduleUnlock, showToast, t, learnHint]
  );

  const handleGroupNext = useCallback(async (entryKey, direction = 1) => {
    let e = feedRef.current.find((x) => x.key === entryKey);
    if (!e || e.unit.items.length < 2) return;
    const currentId = e.unit.items[burstPosRef.current.get(entryKey) || 0]?.id;
    if (direction > 0 && (burstPosRef.current.get(entryKey) || 0) >= e.unit.items.length - 3) {
      const loading = loadMoreNativeGroup(entryKey).catch(error => {
        flightEvent('native-group-page', error?.message || 'retry'); return false;
      });
      if ((burstPosRef.current.get(entryKey) || 0) === e.unit.items.length - 1) {
        await loading;
        e = feedRef.current.find(x => x.key === entryKey) || e;
      }
    }
    if (feedRef.current[activeIndexRef.current]?.key !== entryKey) return;
    const currentNow = e.unit.items[burstPosRef.current.get(entryKey) || 0]?.id || currentId;
    const position = Math.max(0, e.unit.items.findIndex(item => item.id === currentNow));
    if (direction > 0 && position === e.unit.items.length - 1
      && e.unit.nativeOffset < e.unit.nativeCount) return;
    const nextPos = (position + direction + e.unit.items.length) % e.unit.items.length;
    burstPosRef.current.set(entryKey, nextPos);
    getBrowseSession().anchor(e.unit.items[nextPos].id);
    void persistBrowseSession().catch(error => flightEvent('browse-save', error?.message || 'failed'));
    setFeed((prev) => prev.map((x) => (x.key === entryKey ? { ...x } : x)));
  }, []);

  const scrollToNext = useCallback(() => {
    if (advanceLockRef.current) return;
    const next = activeIndexRef.current + 1;
    if (next >= feedRef.current.length) {
      if (feedComplete && next === feedRef.current.length) {
        setScrolling(true);
        listRef.current?.scrollToIndex({ index: next, animated: true });
        scheduleUnlock();
        return;
      }
      loadNextPage();
      return;
    }
    advanceLockRef.current = true;
    setScrolling(true);
    listRef.current?.scrollToIndex({ index: next, animated: true });
    setTimeout(() => {
      advanceLockRef.current = false;
    }, 300);
    scheduleUnlock();
  }, [feedComplete, loadNextPage, scheduleUnlock]);

  const onScroll = useCallback((e) => {
    scrollOffsetRef.current = e.nativeEvent.contentOffset.y;
  }, []);

  const getItemLayout = useCallback(
    (_, index) => ({ length: listH, offset: listH * index, index }),
    [listH]
  );

  useEffect(() => {
    const wasLandscape = landscapeRef.current;
    if (isLandscape && !wasLandscape) {
      clearTimeout(settleTimerRef.current);
      const nextIndex = listH > 0
        ? Math.min(Math.max(Math.round(scrollOffsetRef.current / listH), 0), Math.max(feedRef.current.length - 1, 0))
        : activeIndexRef.current;
      activeIndexRef.current = nextIndex;
      setActiveIndex(nextIndex);
      setCardHorizontalGestureActive(false);
      setCardZoomed(false);
      setScrolling(false);
    } else if (!isLandscape && wasLandscape) {
      restorePortraitRef.current = true;
      setCardZoomed(false);
      setScrolling(true);
    }
    landscapeRef.current = isLandscape;
  }, [isLandscape, listH]);

  const handleListLayout = useCallback(
    (event) => {
      const nextHeight = event.nativeEvent.layout.height;
      setListH(nextHeight);
      if (!isLandscape && restorePortraitRef.current && nextHeight > 0) {
        restorePortraitRef.current = false;
        const target = Math.min(Math.max(activeIndexRef.current, 0), Math.max(feedRef.current.length - 1, 0));
        requestAnimationFrame(() => {
          scrollOffsetRef.current = target * nextHeight;
          listRef.current?.scrollToOffset({ offset: target * nextHeight, animated: false });
          scheduleUnlock();
        });
      }
    },
    [isLandscape, scheduleUnlock]
  );

  const saveBrowse = useCallback(() => {
    void persistBrowseSession().catch(error => flightEvent('browse-save', error?.message || 'failed'));
  }, []);
  useEffect(() => {
    if (loading || scrolling || dayBrowse) return;
    const entry = feed[activeIndex];
    const item = entry?.unit.items[burstPosRef.current.get(entry?.key) || 0];
    if (!item) return;
    getBrowseSession().anchor(item.id); saveBrowse();
  }, [loading, scrolling, dayBrowse, activeIndex, feed, saveBrowse]);
  useEffect(() => {
    if (!dayBrowse || dayScrolling || dayBrowse.loading) return;
    const item = dayBrowse.items[dayWindowIndex];
    if (!item) return;
    const session = getBrowseSession();
    session.enterDay(dayBrowse.items, item.id, session.state.day?.mainId || session.state.anchorId);
    saveBrowse();
  }, [dayBrowse, dayWindowIndex, dayScrolling, saveBrowse]);

  const handleMediaReady = useCallback((item) => {
    const entry = feedRef.current[activeIndexRef.current];
    const current = entry?.unit.items[burstPosRef.current.get(entry.key) || 0];
    if (!item?.id || item.id !== current?.id || dayBrowse || scrolling) return;
    const session = getBrowseSession();
    session.anchor(item.id);
    session.expose(item.id);
    saveBrowse();
    void experience.expose(item, { ready: true, stable: true })
      .then(ok => {
        if (!ok || session !== getBrowseSession()) return;
        if (!journeyRef.current.firstPhoto) {
          journeyRef.current.firstPhoto = true;
          flightEvent('first-photo-ready', Date.now() - journeyRef.current.startedAt);
        }
        photoShown(item, activeIndexRef.current > 0);
      }).catch(() => showToast(t('home.toastMoveFailed')));
  }, [showToast, t, photoShown, dayBrowse, scrolling, saveBrowse]);
  const handleDayMediaReady = useCallback((item) => {
    if (!dayBrowse || dayScrolling || dayBrowse.items[dayWindowIndex]?.id !== item?.id) return;
    getBrowseSession().enterDay(dayBrowse.items, item.id, getBrowseSession().state.anchorId);
    saveBrowse();
    void experience.expose(item, { source: 'day', ready: true, stable: true })
      .catch(() => showToast(t('home.toastMoveFailed')));
  }, [showToast, t, dayBrowse, dayScrolling, dayWindowIndex, saveBrowse]);
  useEffect(() => {
    mediaResources.setInteractive(dayBrowse ? dayScrolling : scrolling || cardHorizontalGestureActive);
    return () => mediaResources.setInteractive(false);
  }, [scrolling, cardHorizontalGestureActive, dayBrowse, dayScrolling]);
  useEffect(() => { if (paywallOpen) flightEvent('paywall-open', paywallReason); }, [paywallOpen, paywallReason]);
  useEffect(() => {
    if (moreMenuOpen || paywallOpen || trashOpen || !appActive) silenceAllPlayers();
  }, [moreMenuOpen, paywallOpen, trashOpen, appActive]);

  useEffect(() => {
    if (activeIndex < 80 || scrolling || dayBrowse || isLandscape) return;
    const keepFrom = activeIndex - 40;
    const removed = feedRef.current.slice(0, keepFrom);
    for (const entry of removed) {
      if (entry.unit.items.length > 1) releaseUnviewedBurstFrames(entry.unit.items, null);
      burstPosRef.current.delete(entry.key);
    }
    const retainedFeed = feedRef.current.slice(keepFrom);
    const retainedIds = new Set(retainedFeed.flatMap(entry => entry.unit.items.map(item => item.id)));
    rawAssetsRef.current = rawAssetsRef.current.filter(item => retainedIds.has(item.id));
    feedRef.current = retainedFeed;
    const nextIndex = activeIndex - keepFrom;
    activeIndexRef.current = nextIndex;
    previousActiveIndexRef.current = nextIndex;
    scrollOffsetRef.current = nextIndex * listH;
    setFeed(retainedFeed); setActiveIndex(nextIndex);
    requestAnimationFrame(() => listRef.current?.scrollToOffset({ offset: nextIndex * listH, animated: false }));
  }, [activeIndex, scrolling, dayBrowse, isLandscape, listH]);

  const landscapeEntry = feed[activeIndex] || feed[0];
  const landscapePosition = landscapeEntry ? burstPosRef.current.get(landscapeEntry.key) || 0 : 0;
  const landscapeItem = landscapeEntry?.unit.items[landscapePosition] || landscapeEntry?.unit.items[0];

  const toastY = toastAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [14, 0],
  });
  const toastOpacity = toastAnim;
  const listData = useMemo(() => {
    if ((feedComplete && getUnresolvedMediaCount() > 0) || (loadStatus === 'error' && !hasNextPageRef.current)) return [...feed, RETRY_ENTRY];
    return feedComplete ? [...feed, COMPLETION_ENTRY] : feed;
  }, [feed, feedComplete, loadStatus]);

  return (
    <View style={styles.container}>
      <StatusBar style="light" />

      <View style={styles.listWrap} onLayout={handleListLayout}>
        {loading && !feed.length ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={[styles.emptyHint, { marginTop: 16 }]}>{t('home.loadingHint')}</Text>
          </View>
        ) : !rawAssetsRef.current.length ? (() => {
          // Distinct "still preparing" state: while the auto-retry safety net
          // has not been exhausted, an empty first page must NOT be presented
          // as the final "no accessible photos" verdict.
          if (loadStatus === 'empty-library' && emptyRetryCount < EMPTY_LIBRARY_RETRY_LIMIT) {
            return (
              <View style={styles.center}>
                <ActivityIndicator size="large" color={colors.primary} />
                <Text style={[styles.emptyHint, { marginTop: 16 }]}>{t('home.preparingHint')}</Text>
              </View>
            );
          }
          const emptyCopy = {
            'limited-empty': {
              title: t('home.emptyLimitedTitle'),
              hint: t('home.emptyLimitedHint'),
              action: t('home.emptySelectPhotos'),
            },
            'all-viewed': {
              title: t('home.allViewedTitle'),
              hint: t('home.emptyAllViewedHint'),
              action: t('home.restart'),
            },
            'cloud-pending': {
              title: t('home.emptyCloudTitle'),
              hint: t('home.emptyCloudHint'),
              action: t('home.retryBtn'),
            },
            error: {
              title: t('home.emptyErrorTitle'),
              hint: t(loadError?.photoLoadStage === 'permission' ? 'home.emptyNoPermissionHint' : 'home.emptyErrorHint'),
              action: t('home.retryBtn'),
            },
            'empty-library': {
              title: t('home.emptyLibraryTitle'),
              hint: t('home.emptyLibraryHint'),
              action: t('home.refreshBtn'),
            },
          }[loadStatus] || {
            title: t('home.emptyLibraryTitle'),
            hint: loadError ? t('home.emptyRetryLaterHint') : t('home.emptyNoPermissionHint'),
            action: t('home.refreshBtn'),
          };
          return (
            <View style={styles.center}>
              <Ionicons name="images-outline" size={64} color={colors.textMuted} />
              <Text style={styles.emptyText}>{emptyCopy.title}</Text>
              <Text style={styles.emptyHint}>{emptyCopy.hint}</Text>
              <Pressable style={styles.refreshBtn} onPress={loadStatus === 'limited-empty' ? managePhotoAccess : loadStatus === 'all-viewed' ? handleResetViewedHistory : retryLoad}>
                <Ionicons name="refresh" size={16} color="#fff" />
                <Text style={styles.refreshBtnText}>{emptyCopy.action}</Text>
              </Pressable>
            </View>
          );
        })() : dayBrowse ? (
          <DayMemoryCarousel
            items={dayBrowse.items}
            initialIndex={dayBrowse.initialIndex}
            loading={dayBrowse.loading}
            onExit={exitDayBrowse}
            onWindowIndexChange={setDayWindowIndex}
            onInteractionChange={setDayScrolling}
            constrained={constrained}
            onLoadBefore={loadDayBefore}
            onLoadAfter={loadDayAfter}
            hasBefore={dayBrowse.hasBefore}
            hasAfter={dayBrowse.hasAfter}
            onPrepareTrash={prepareTrash}
            paused={paywallOpen || moreMenuOpen || trashOpen || !appActive}
            onTrash={handleDayTrash}
            onViewed={handleDayMediaReady}
          />
        ) : isLandscape ? (
          landscapeItem && listH > 0 ? (
            <MemoryCard
              item={landscapeItem}
              items={[landscapeItem]}
              height={listH}
              active={isFocused && appActive && !scrolling && !trashOpen && !moreMenuOpen && !paywallOpen}
              onMediaReady={handleMediaReady}
              preload
              onAdvance={() => {}}
              onTrash={() => {}}
              onFavoriteChange={() => {}}
              onGroupNext={() => {}}
              onZoomStateChange={setCardZoomed}
              onHorizontalGestureChange={handleHorizontalGestureChange}
              onPinchIn={() => {}}
              showInfo={false}
              onVideoPlayerChange={handleVideoPlayerChange}
              allowFeedGestures={false}
              groupIndex={0}
              groupCount={1}
            />
          ) : null
        ) : listH > 0 ? (
          <FlatList
            ref={listRef}
            data={listData}
            initialScrollIndex={activeIndex}
            keyExtractor={(e) => e.key}
            renderItem={({ item, index }) => {
              if (item.kind === 'retry') {
                return <View style={[styles.center, { height: listH }]}>
                  <Text style={styles.emptyText}>{t('home.emptyErrorTitle')}</Text>
                  <Text style={styles.emptyHint}>{t('home.emptyErrorHint')}</Text>
                  <Pressable style={styles.refreshBtn} onPress={retryLoad}>
                    <Text style={styles.refreshBtnText}>{t('home.retryBtn')}</Text>
                  </Pressable>
                </View>;
              }
              if (item.kind === 'complete') {
                // Rating invitation lives ONLY on the completion page: the swipe
                // flow is already finished here, so it can never interrupt it.
                const ratingVisible = shouldOfferRatingPrompt({
                  cleanedBytes: getTotalCleanedBytes(),
                  promptState: ratingState,
                });
                return (
                  <View style={[styles.center, { height: listH }]}>
                    <Ionicons name="checkmark-circle-outline" size={64} color={colors.primary} />
                    <Text style={styles.emptyText}>{t('home.allViewedTitle')}</Text>
                    <Text style={styles.emptyHint}>{t('home.allViewedHint')}</Text>
                    <Pressable style={styles.refreshBtn} onPress={handleResetViewedHistory}>
                      <Ionicons name="refresh" size={16} color="#fff" />
                      <Text style={styles.refreshBtnText}>{t('home.restart')}</Text>
                    </Pressable>
                    {ratingVisible ? (
                      <GlassPanel style={styles.ratingCard} radius={20} intensity={55}>
                        <View style={styles.ratingCardHead}>
                          <Ionicons name="heart" size={15} color={colors.catPaw} />
                          <Text style={styles.ratingCardTitle}>{t('rating.cardTitle')}</Text>
                        </View>
                        <Text style={styles.ratingCardBody}>{t('rating.cardBody')}</Text>
                        <JellyPressable style={styles.ratingPrimaryBtn} onPress={handleRateApp}>
                          <Ionicons name="star" size={14} color="#111827" />
                          <Text style={styles.ratingPrimaryBtnText}>{t('rating.rateBtn')}</Text>
                        </JellyPressable>
                        <Pressable style={styles.ratingLaterBtn} onPress={handleRateLater} hitSlop={8}>
                          <Text style={styles.ratingLaterBtnText}>{t('rating.laterBtn')}</Text>
                        </Pressable>
                      </GlassPanel>
                    ) : null}
                  </View>
                );
              }
              const pos = burstPosRef.current.get(item.key) || 0;
              const cur = item.unit.items[pos] || item.unit.items[0];
              // Defensive: a degenerate unit must not reach MemoryCard — its
              // render dereferences item unguarded (stability audit #2).
              if (!cur) return null;
              return (
                <MemoryCard
                  item={cur}
                  items={item.unit.items}
                  height={listH}
                  active={index === activeIndex && isFocused && appActive && !scrolling && !trashOpen && !dayBrowse && !moreMenuOpen && !paywallOpen}
                  onMediaReady={handleMediaReady}
                  preload={Math.abs(index - activeIndex) <= 1}
                  retainPlayer={index === activeIndex && isFocused && appActive && !trashOpen && !dayBrowse && !moreMenuOpen && !paywallOpen}
                  constrained={constrained}
                  videoPreload={!constrained && index === activeIndex + 1 && isFocused && appActive && !trashOpen && !dayBrowse && !moreMenuOpen && !paywallOpen}
                  onAdvance={scrollToNext}
                  onPrepareTrash={prepareTrash}
                  onTrash={(selectedItem) => handleTrash(item, selectedItem)}
                  onFavoriteChange={(favorite) => { showToast(favorite ? t('home.toastFavorited') : t('home.toastUnfavorited'), favorite ? 'favorite' : 'unfavorite'); }}
                  onGroupNext={(direction) => handleGroupNext(item.key, direction)}
                  onZoomStateChange={setCardZoomed}
                  onHorizontalGestureChange={handleHorizontalGestureChange}
                  onPinchIn={enterDayBrowse}
                  onVideoPlayerChange={handleVideoPlayerChange}
                  allowFeedGestures={!isLandscape}
                  groupIndex={pos}
                  groupCount={item.unit.items.length}
                  showInfo={false}
                />
              );
            }}
            pagingEnabled
            directionalLockEnabled
            scrollEnabled={!cardZoomed && !cardHorizontalGestureActive && !isLandscape}
            showsVerticalScrollIndicator={false}
            onScroll={onScroll}
            scrollEventThrottle={16}
            getItemLayout={getItemLayout}
            onScrollBeginDrag={() => {
              clearTimeout(settleTimerRef.current);
              silenceAllPlayers();
              setCardHorizontalGestureActive(false);
              startBurstDiscoveryOnce();
              setScrolling(true);
            }}
            onScrollEndDrag={(e) => {
              // Slow drag without inertia: release after the viewport settles.
              const v = e.nativeEvent.velocity;
              if (!v || (Math.abs(v.y) < 0.1 && Math.abs(v.x) < 0.1)) scheduleUnlock();
            }}
            onMomentumScrollBegin={() => setScrolling(true)}
            onMomentumScrollEnd={scheduleUnlock}
            onEndReached={loadNextPage}
            onEndReachedThreshold={2}
            windowSize={3}
            initialNumToRender={2}
            maxToRenderPerBatch={2}
            updateCellsBatchingPeriod={40}
            removeClippedSubviews={Platform.OS === 'android'}
          />
        ) : null}
      </View>

      {!dayBrowse && !trashOpen && !isLandscape && feed[activeIndex] ? (() => {
        const entry = feed[activeIndex];
        const position = burstPosRef.current.get(entry.key) || 0;
        const current = entry.unit.items[position] || entry.unit.items[0];
        return <MemoryInfoPanel item={current} groupIndex={position} groupCount={entry.unit.items.length} top={insets.top + 12} />;
      })() : null}

      {!trashOpen && (!dayBrowse || isLandscape) && activeVideoPlayer && !activeVideoPlayer.live ? (
        <VideoProgressControl
          player={activeVideoPlayer.player}
          bottom={isLandscape ? Math.max(insets.bottom, 12) + 12 : insets.bottom + 70}
        />
      ) : null}

      {!dayBrowse && !trashOpen && !isLandscape ? (
        <View style={[styles.topRightControls, { top: insets.top + 12 }]}>
          <JellyPressable
            style={styles.headerBtn}
            onPress={() => setMoreMenuOpen(true)}
            hitSlop={8}
          >
            <GlassPanel style={styles.moreMenuBtn} radius={23} intensity={62}>
              <Ionicons name="ellipsis-horizontal" size={20} color="#FFFFFF" />
            </GlassPanel>
          </JellyPressable>
        </View>
      ) : null}

      {/* Trash box: floating liquid-glass button, centered at the bottom */}
      {!dayBrowse && !isLandscape ? <BottomControls
        bottom={insets.bottom + 4}
        summary={trashSummary}
        canUndo={!!undoTrash}
        onShare={handleShareCurrent}
        onOpenTrash={openTrash}
        onUndo={handleUndoTrash}
      /> : null}

      <TrashGallery
        visible={trashOpen}
        onClose={() => setTrashOpen(false)}
        onChanged={(restoredItem) => {
          setUndoTrash(null);
          // A restore from the gallery must flow back into the main feed:
          // clear the mirror id, rebuild, and keep the user anchored on the
          // card they were viewing (ISSUE-002).
          if (restoredItem?.id) {
            if (!rawAssetsRef.current.some(item => item.id === restoredItem.id)) rawAssetsRef.current.push(restoredItem);
            rebuildFeedPreservingPosition();
          }
          refreshTrashSummary();
        }}
      />

      <MoreMenuModal
        visible={moreMenuOpen}
        onClose={() => setMoreMenuOpen(false)}
        membership={membership}
        trashSummary={trashSummary}
        onManagePermissions={managePhotoAccess}
        onResetViewedHistory={handleResetViewedHistory}
        onRecommendModeChange={handleRecommendModeChange}
        onToast={showToast}
        onOpenPaywall={() => { setPaywallReason('menu'); setPaywallOpen(true); }}
      />

      <PaywallModal
        visible={paywallOpen}
        reason={paywallReason}
        onClose={() => setPaywallOpen(false)}
        onToast={showToast}
      />

      {/* First-run gesture coach */}
      <SwipeCoachOverlay
        visible={Boolean(hint) && appActive && !scrolling && !trashOpen && !moreMenuOpen && !paywallOpen && !dayBrowse && !isLandscape}
        variant={hint}
        onDismiss={() => learnHint('dismiss')}
      />

      {/* Toast */}
      {toast ? (
        <Animated.View
          style={[
            styles.toastWrap,
            {
              bottom: insets.bottom + 72,
              opacity: toastOpacity,
              transform: [{ translateY: toastY }],
            },
          ]}
          pointerEvents="none"
        >
          <GlassPanel style={styles.toastPill} radius={20} intensity={65} shadow={true}>
            <Ionicons
              name={
                toast.kind === 'unfavorite'
                  ? 'heart-dislike-outline'
                  : toast.kind === 'favorite'
                  ? 'heart'
                  : toast.kind === 'undo'
                  ? 'arrow-undo'
                  : 'checkmark-circle'
              }
              size={15}
              color={
                toast.kind === 'unfavorite'
                  ? colors.textMuted
                  : toast.kind === 'favorite'
                  ? colors.fav
                  : colors.success
              }
            />
            <Text style={styles.toastText}>{toast.text}</Text>
          </GlassPanel>
        </Animated.View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#000',
    gap: 12,
    paddingHorizontal: 24,
  },
  emptyText: {
    color: colors.textMuted,
    fontSize: 16,
  },
  emptyHint: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 20,
  },
  refreshBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(139,92,246,0.25)',
    borderColor: colors.primarySoft,
    borderWidth: 1,
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  refreshBtnText: {
    color: '#fff',
    fontSize: 13,
  },
  ratingCard: {
    width: '100%',
    maxWidth: 300,
    alignItems: 'center',
    gap: 10,
    padding: 18,
    marginTop: 8,
    backgroundColor: 'rgba(24, 26, 32, 0.88)',
  },
  ratingCardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  ratingCardTitle: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
  },
  ratingCardBody: {
    color: 'rgba(255,255,255,0.62)',
    fontSize: 12.5,
    lineHeight: 18,
    textAlign: 'center',
  },
  ratingPrimaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    alignSelf: 'stretch',
    minHeight: 44,
    borderRadius: 14,
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  ratingPrimaryBtnText: {
    color: '#111827',
    fontSize: 14,
    fontWeight: '800',
  },
  ratingLaterBtn: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  ratingLaterBtnText: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 13,
  },
  listWrap: {
    flex: 1,
  },
  trashCapWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 15,
  },
  topRightControls: {
    position: 'absolute',
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    zIndex: 20,
  },
  headerBtn: {},
  moreMenuBtn: {
    width: 46,
    height: 46,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(120, 80, 255, 0.30)',
  },
  trashCap: {
    minWidth: 156,
    height: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 16,
    backgroundColor: 'rgba(120, 80, 255, 0.30)',
  },
  trashCapText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.15,
  },
  bottomLeftSlot: {
    position: 'absolute',
    left: 18,
    top: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'flex-start',
  },
  bottomCenterSlot: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  bottomRightSlot: {
    position: 'absolute',
    right: 16,
    top: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'flex-end',
  },
  bottomRoundPanel: {
    width: 46,
    height: 46,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(120, 80, 255, 0.30)',
  },
  bottomRoundPanelSpacer: {
    width: 46,
    height: 46,
  },
  toastWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 99,
  },
  toastPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: 'rgba(255, 255, 255, 0.18)',
    borderColor: 'rgba(255, 255, 255, 0.40)',
  },
  toastText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
});

