import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  FlatList,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, formatBytes } from '../theme';
import { beginMotionDrag, moveMotionDrag, exitMotion, settleMotion, useReducedMotion } from '../motion';
import { GlassPanel, JellyPressable } from './Glass';
import { emptyTrash, fetchTrashSummary, fetchTrashItems, getAssetSizeBytes, getDisplayUri, getUriFallback, isVideoAsset, loadExif, restoreFromTrash } from '../media';
import { getRenderableImageUri } from '../mediaPage.mjs';
import PhotoKitPreview from './PhotoKitPreview';
import { supportsNativePhotoPreview } from '../nativePhotoPreview';
import MaoQiuIcon from './MaoQiuIcon';
import { useI18n } from '../i18n';

const videoCoverCache = new Map();

function photoUri(item) {
  const candidates = [item?.localUri, item?.imageUri, item?.displayUri];
  return candidates.map((uri) => getRenderableImageUri(uri, Platform.OS !== 'ios')).find(Boolean) || null;
}

async function loadVideoCover(item) {
  // v129: prefer the permission-bearing readable URI from getUriFallback
  // (requestAVAsset's AVURLAsset.url — a readable file:// that VideoThumbnails
  // can read on iOS 18+). Strip the PhotoKit bookmark fragment (#...) from the
  // localUri as a secondary candidate.
  const candidates = [];
  try {
    const readable = await getUriFallback(item);
    if (typeof readable === 'string' && readable.startsWith('file://')) candidates.push(readable);
  } catch {}
  candidates.push(
    ...[item?.displayUri, item?.localUri, item?.imageUri]
      .filter((uri) => typeof uri === 'string' && uri.length > 0)
      .map((uri) => uri.split('#')[0])
  );
  for (const src of candidates) {
    if (videoCoverCache.has(src)) return videoCoverCache.get(src);
  }
  for (const src of candidates) {
    try {
      const { uri } = await VideoThumbnails.getThumbnailAsync(src, { time: 0 });
      if (uri) { videoCoverCache.set(src, uri); return uri; }
    } catch {}
  }
  for (const src of candidates) {
    try {
      const { uri } = await VideoThumbnails.getThumbnailAsync(src, { time: 500 });
      if (uri) { videoCoverCache.set(src, uri); return uri; }
    } catch {}
  }
  return null;
}

function TrashVideoPreview({ uri }) {
  const player = useVideoPlayer(uri, (instance) => {
    // Same defensive pattern as MemoryCard: never let a player property call
    // escape during setup.
    try {
      instance.loop = true;
      instance.muted = true;
      instance.volume = 0;
      instance.play();
    } catch {}
  });

  return <VideoView player={player} style={styles.previewVideo} contentFit="contain" nativeControls />;
}

function formatDateTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function exifValue(exif, ...keys) {
  for (const key of keys) {
    const value = exif?.[key];
    if (value !== undefined && value !== null && value !== '') return String(value);
  }
  return '';
}

export default function TrashGallery({ visible, onClose, onChanged }) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const reduceMotion = useReducedMotion();
  const [items, setItems] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const pageLoadingRef = useRef(false);
  const [sizeBytes, setSizeBytes] = useState(0);
  const [unknownCount, setUnknownCount] = useState(0);
  const [previewIndex, setPreviewIndex] = useState(null);
  const [previewDetails, setPreviewDetails] = useState(false);
  const [previewMeta, setPreviewMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [deleteNotice, setDeleteNotice] = useState(false);
  const deletingRef = useRef(false);
  const refreshVersionRef = useRef(0);
  const dismissY = useRef(new Animated.Value(0)).current;
  const dismissDrag = useRef({ version: 0, position: 0, min: 0, dragging: false, ready: false }).current;
  const dismissingRef = useRef(false);
  // Video covers that already went through thumbnail generation (success or
  // failure). Retrying on every refresh re-ran heavy AVAsset jobs for videos
  // whose cover simply cannot be extracted, stalling the grid.
  const coverAttemptedRef = useRef(new Set());
  const { t, formatLocalizedDate } = useI18n();

  const closeFromDrag = useCallback((position, velocity) => {
    if (dismissingRef.current || deletingRef.current) return;
    dismissingRef.current = true;
    const version = dismissDrag.version;
    exitMotion(dismissY, position, Math.max(height, position), velocity, reduceMotion).start(({ finished }) => {
      if (!finished || dismissDrag.version !== version) return;
      dismissY.setValue(0);
      dismissingRef.current = false;
      onClose?.();
    });
  }, [dismissY, height, onClose, dismissDrag, reduceMotion]);

  const closePanResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gestureState) =>
          !dismissingRef.current && !deletingRef.current && gestureState.dy > 8 && Math.abs(gestureState.dy) > Math.abs(gestureState.dx),
        onPanResponderGrant: (_, g) => beginMotionDrag(dismissY, dismissDrag, Math.max(0, g.dy)),
        onPanResponderMove: (_, gestureState) => moveMotionDrag(dismissY, dismissDrag, Math.max(0, gestureState.dy)),
        onPanResponderRelease: (event, gestureState) => {
          if (!dismissDrag.ready) {
            const released = { ...gestureState };
            dismissDrag.onReady = () => closePanResponder.panHandlers.onPanResponderRelease(event, released);
            return;
          }
          dismissDrag.dragging = false;
          if (gestureState.dy > 96 || gestureState.vy > 1.05) {
            closeFromDrag(dismissDrag.position, gestureState.vy);
            return;
          }
          settleMotion(dismissY, 0, { velocity: gestureState.vy, reduced: reduceMotion }).start();
        },
        onPanResponderTerminate: () => {
          dismissDrag.dragging = false;
          settleMotion(dismissY, 0, { reduced: reduceMotion }).start();
        },
      }),
    [closeFromDrag, dismissY, dismissDrag, reduceMotion]
  );

  const refresh = useCallback(async () => {
    const version = ++refreshVersionRef.current;
    const { items: list, count, sizeBytes: totalBytes, unknownCount: unknown } = await fetchTrashSummary();
    if (version !== refreshVersionRef.current || deletingRef.current) return;
    // Guarantee displayUri and ph:// fallback for instant 0ms native image decoding
    list.forEach((a) => {
      if (!a.displayUri) {
        a.displayUri = a.uri || (a.id ? (a.id.startsWith('ph://') ? a.id : `ph://${a.id}`) : null);
      }
    });
    setItems(list);
    setTotalCount(count);
    setSizeBytes(totalBytes);
    setUnknownCount(unknown);
    setLoading(false);

    // Enhance video covers in the background without stalling grid UI.
    // Bounded concurrency (3) + one attempt per asset per session: an
    // unbounded fan-out of thumbnail extractions was freezing the grid.
    const pendingCovers = list.filter(
      (a) => !supportsNativePhotoPreview && isVideoAsset(a) && !a.thumbnailUri && !coverAttemptedRef.current.has(a.id)
    );
    let coverCursor = 0;
    const coverWorkers = Array.from({ length: Math.min(3, pendingCovers.length) }, async () => {
      while (coverCursor < pendingCovers.length && version === refreshVersionRef.current && !deletingRef.current) {
        const a = pendingCovers[coverCursor++];
        coverAttemptedRef.current.add(a.id);
        try {
          const thumb = await loadVideoCover(a);
          if (thumb && version === refreshVersionRef.current && !deletingRef.current) {
            a.thumbnailUri = thumb;
            setItems((prev) => prev.map((item) => (item.id === a.id ? { ...item, thumbnailUri: thumb } : item)));
          }
        } catch {}
      }
    });
    Promise.all(coverWorkers).catch(() => {});
  }, []);

  useEffect(() => {
    if (!visible) return;
    setPreviewIndex(null);
    setPreviewDetails(false);
    setDeleteNotice(false);
    refresh().catch(() => setLoading(false));
    return () => { refreshVersionRef.current += 1; };
  }, [visible, refresh]);

  useEffect(() => {
    const item = previewIndex === null ? null : items[previewIndex];
    if (!previewDetails || !item) {
      setPreviewMeta(null);
      return undefined;
    }
    let cancelled = false;
    Promise.all([getAssetSizeBytes(item), loadExif(item)]).then(([sizeBytes, exif]) => {
      if (!cancelled) setPreviewMeta({ sizeBytes, exif: exif || {} });
    });
    return () => { cancelled = true; };
  }, [items, previewDetails, previewIndex]);

  const handleRestore = useCallback(
    async (item) => {
      if (!item || deletingRef.current) return;
      // markForTrash already updates media.js caches synchronously, so the
      // local list edit is the full state update. Re-running refresh() here
      // re-fetched the whole summary on every consecutive restore and starved
      // the grid (black cells + slow thumbnails); HomeScreen's onChanged
      // handler refreshes its own summary cheaply instead.
      restoreFromTrash(item);
      const nextList = items.filter((a) => a.id !== item.id);
      setItems(nextList);
      setTotalCount(count => Math.max(0, count - 1));
      if (!item.fileSizeBytes && !item.fileSize) setUnknownCount(count => Math.max(0, count - 1));
      // Mirror fetchTrashSummary's accounting: known bytes, else ~3.2MB estimate.
      const restoredBytes = item.fileSizeBytes || item.fileSize || 3355443;
      setSizeBytes((prev) => Math.max(0, prev - restoredBytes));
      if (previewIndex !== null) {
        if (nextList.length === 0) setPreviewIndex(null);
        else if (previewIndex >= nextList.length) setPreviewIndex(nextList.length - 1);
      }
      onChanged?.(item);
    },
    [items, previewIndex, onChanged]
  );

  const handleEmpty = useCallback(async () => {
    if (!items.length || deletingRef.current) return;
    deletingRef.current = true;
    refreshVersionRef.current += 1; // Stop background cover/summary updates.
    setDeleting(true);
    setDeleteNotice(false);
    try {
      // Let React commit the busy state before requesting the system sheet.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const deletedCount = await emptyTrash();
      if (deletedCount > 0) onChanged?.();
      else setDeleteNotice(false);
    } catch (error) {
      // Cancellation and failure both retain the pending items. No extra dialog.
      setDeleteNotice(true);
    } finally {
      deletingRef.current = false;
      try { await refresh(); } catch { setDeleteNotice(true); }
      setDeleting(false);
    }
  }, [items.length, onChanged, refresh]);

  const loadMore = useCallback(async () => {
    if (pageLoadingRef.current || deletingRef.current || items.length >= totalCount) return;
    pageLoadingRef.current = true;
    const version = refreshVersionRef.current;
    try {
      const next = await fetchTrashItems(120, items.length);
      if (version === refreshVersionRef.current && !deletingRef.current) setItems(previous => [...new Map([...previous,...next].map(item => [item.id,item])).values()]);
    } catch { setDeleteNotice(true); }
    finally { pageLoadingRef.current = false; }
  }, [items.length, totalCount]);

  const previewListRef = useRef(null);
  const previewDismissY = useRef(new Animated.Value(0)).current;
  const previewDrag = useRef({ version: 0, position: 0, min: 0, dragging: false, ready: false }).current;
  const previewDismissing = useRef(false);

  useEffect(() => () => {
    dismissDrag.version++;
    dismissDrag.dragging = false;
    dismissY.stopAnimation();
    dismissY.setValue(0);
    dismissingRef.current = false;
  }, [visible, dismissY, dismissDrag]);
  useEffect(() => () => {
    previewDrag.version++;
    previewDrag.dragging = false;
    previewDismissY.stopAnimation();
    previewDismissY.setValue(0);
    previewDismissing.current = false;
  }, [visible, previewIndex, previewDismissY, previewDrag]);

  const previewVerticalPan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gestureState) =>
          !previewDismissing.current && ((gestureState.dy > 10 && Math.abs(gestureState.dy) > Math.abs(gestureState.dx) * 1.15) ||
          (gestureState.dy < -16 && Math.abs(gestureState.dy) > Math.abs(gestureState.dx) * 1.5)),
        onPanResponderGrant: (_, g) => beginMotionDrag(previewDismissY, previewDrag, Math.max(0, g.dy)),
        onPanResponderMove: (_, gestureState) => {
          if (gestureState.dy > 0) {
            moveMotionDrag(previewDismissY, previewDrag, gestureState.dy);
          }
        },
        onPanResponderRelease: (event, gestureState) => {
          if (!previewDrag.ready) {
            const released = { ...gestureState };
            previewDrag.onReady = () => previewVerticalPan.panHandlers.onPanResponderRelease(event, released);
            return;
          }
          previewDrag.dragging = false;
          if (gestureState.dy > 45 || gestureState.vy > 0.5) {
            previewDismissing.current = true;
            const version = previewDrag.version;
            exitMotion(previewDismissY, previewDrag.position, Math.max(height, previewDrag.position), gestureState.vy, reduceMotion).start(({ finished }) => {
              if (!finished || previewDrag.version !== version) return;
              setPreviewDetails(false);
              setPreviewIndex(null);
              previewDismissY.setValue(0);
              previewDismissing.current = false;
            });
            return;
          }
          settleMotion(previewDismissY, 0, { velocity: gestureState.vy, reduced: reduceMotion }).start();

          if (gestureState.dy < -35) {
            setPreviewDetails(true);
          }
        },
        onPanResponderTerminate: () => {
          previewDrag.dragging = false;
          settleMotion(previewDismissY, 0, { reduced: reduceMotion }).start();
        },
      }),
    [height, previewDismissY, previewDrag, reduceMotion]
  );

  const cell = Math.floor((width - 8) / 3) - 8;

  const renderGrid = () => {
    if (loading) {
      return <Text style={styles.emptyText}>{t('common.loading')}</Text>;
    }
    if (items.length === 0) {
      return (
        <View style={styles.emptyWrap} {...closePanResponder.panHandlers}>
          <MaoQiuIcon size={39} color="rgba(255,255,255,0.40)" />
          <Text style={styles.emptyText}>{t('trash.emptyTitle')}</Text>
          <Text style={styles.emptyHint}>{t('trash.emptyDesc')}</Text>
        </View>
      );
    }
    return (
      <FlatList
        data={items}
        numColumns={3}
        onEndReached={loadMore}
        onEndReachedThreshold={1}
        windowSize={3}
        initialNumToRender={12}
        maxToRenderPerBatch={6}
        keyExtractor={(a) => a.id}
        contentContainerStyle={[styles.gridContent, { paddingBottom: insets.bottom + 104 }]}
        onScrollEndDrag={(e) => {
          if (e.nativeEvent.contentOffset.y < -45) {
            closeFromDrag();
          }
        }}
        renderItem={({ item, index }) => {
          const uri = photoUri(item);
          const phUri = item.id ? (item.id.startsWith('ph://') ? item.id : `ph://${item.id}`) : null;
          const videoSrc = item.thumbnailUri
            || (item.displayUri && item.displayUri.startsWith('ph://') ? item.displayUri : null)
            || (uri && uri.startsWith('ph://') ? uri : null)
            || phUri;
          const nativePreview = !uri && !isVideoAsset(item) ? item.previewUri : null;
          return (
            <Pressable
              style={[styles.cell, { width: cell, height: cell }]}
              onPress={() => {
                setPreviewDetails(false);
                setPreviewIndex(index);
              }}
            >
              {supportsNativePhotoPreview ? (
                <PhotoKitPreview priority={1} networkAccess purpose="trashGrid" assetId={item.id} style={styles.cellImg} resizeMode="cover" />
              ) : isVideoAsset(item) ? (
                <>
                  <ExpoImage source={{ uri: videoSrc }} style={styles.cellImg} contentFit="cover" transition={100} />
                  <View style={styles.videoCoverBadge} pointerEvents="none">
                    <Ionicons name="play" size={11} color="#fff" />
                  </View>
                </>
              ) : uri ? (
                <ExpoImage source={{ uri }} style={styles.cellImg} contentFit="cover" transition={150} />
              ) : nativePreview ? (
                <PhotoKitPreview priority={1} networkAccess purpose="trashGrid" uri={nativePreview} style={styles.cellImg} resizeMode="cover" />
              ) : (
                <Ionicons name="image-outline" size={28} color="rgba(255,255,255,0.45)" />
              )}

              <View style={styles.cellRestoreBtn} pointerEvents="box-none">
                <JellyPressable
                  onPress={(e) => {
                    e?.stopPropagation?.();
                    handleRestore(item);
                  }}
                  hitSlop={8}
                >
                  <GlassPanel style={styles.cellRestoreInner} radius={13} intensity={70}>
                    <Ionicons name="arrow-undo" size={12} color="#FFFFFF" />
                  </GlassPanel>
                </JellyPressable>
              </View>
            </Pressable>
          );
        }}
      />
    );
  };

  const renderPreview = () => {
    const currentItem = items[previewIndex] || items[0];
    if (!currentItem) return null;

    return (
      <Animated.View
        style={[
          styles.previewWrap,
          { transform: [{ translateY: previewDismissY }] },
        ]}
        {...previewVerticalPan.panHandlers}
      >
        <FlatList
          ref={previewListRef}
          data={items}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          initialScrollIndex={previewIndex !== null ? previewIndex : 0}
          getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
          onMomentumScrollEnd={(e) => {
            const nextIdx = Math.max(0, Math.min(items.length - 1, Math.round(e.nativeEvent.contentOffset.x / width)));
            if (nextIdx !== previewIndex) {
              setPreviewIndex(nextIdx);
              setPreviewDetails(false);
            }
          }}
          renderItem={({ item, index }) => {
            const isCurrent = index === previewIndex;
            const uri = photoUri(item);
            const nativePreview = !uri && !isVideoAsset(item) ? item.previewUri : null;
            return (
              <View style={[styles.previewSlide, { width, height }]}>
                {isVideoAsset(item) && item.displayUri ? (
                  isCurrent ? <TrashVideoPreview key={item.id} uri={item.displayUri} /> : null
                ) : supportsNativePhotoPreview && !isVideoAsset(item) ? (
                  <PhotoKitPreview priority={0} purpose="trashPreview" assetId={item.id} style={styles.previewImg} resizeMode="contain" />
                ) : uri && !isVideoAsset(item) ? (
                  <ExpoImage source={{ uri }} style={styles.previewImg} contentFit="contain" transition={120} />
                ) : nativePreview ? (
                  <PhotoKitPreview priority={0} purpose="trashPreview" uri={nativePreview} style={styles.previewImg} resizeMode="contain" />
                ) : (
                  <Ionicons name="videocam-outline" size={54} color="rgba(255,255,255,0.45)" />
                )}
              </View>
            );
          }}
          keyExtractor={(it) => it.id}
        />

        {previewDetails ? (
          <GlassPanel style={styles.previewDetails} radius={22} intensity={52}>
            <Text style={styles.previewDetailsTitle}>{formatLocalizedDate(currentItem.creationTime)}</Text>
            {currentItem.filename ? <Text style={styles.previewDetailsText}>{currentItem.filename}</Text> : null}
            {currentItem.width && currentItem.height ? <Text style={styles.previewDetailsText}>{`${currentItem.width} × ${currentItem.height}`}</Text> : null}
            {previewMeta?.sizeBytes > 0 ? <Text style={styles.previewDetailsText}>{formatBytes(previewMeta.sizeBytes)}</Text> : null}
            {exifValue(previewMeta?.exif, 'Make', 'Model') ? <Text style={styles.previewDetailsText}>{[exifValue(previewMeta?.exif, 'Make'), exifValue(previewMeta?.exif, 'Model')].filter(Boolean).join(' ')}</Text> : null}
          </GlassPanel>
        ) : null}

        <JellyPressable
          style={[styles.previewRestoreWrap, { bottom: insets.bottom + 16 }]}
          onPress={() => handleRestore(currentItem)}
          hitSlop={6}
        >
          <GlassPanel style={styles.previewRestore} radius={23} intensity={62}>
            <Ionicons name="arrow-undo" size={17} color="#FFFFFF" />
            <Text style={styles.actionText}>{t('common.restore')}</Text>
          </GlassPanel>
        </JellyPressable>
      </Animated.View>
    );
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={() => { if (!deletingRef.current) onClose?.(); }} statusBarTranslucent>
      <Animated.View style={[styles.root, { transform: [{ translateY: dismissY }] }]}>
        <View style={[styles.topBar, { paddingTop: insets.top + 8, zIndex: 50 }]} {...closePanResponder.panHandlers}>
          <GlassPanel style={styles.topBarInner} radius={24} intensity={56}>
            <JellyPressable
              style={styles.topBtn}
              onPress={previewIndex === null ? onClose : () => setPreviewIndex(null)}
              disabled={deleting}
              hitSlop={6}
            >
              <Ionicons name={previewIndex === null ? 'close' : 'chevron-back'} size={22} color={colors.text} />
            </JellyPressable>
            <View style={styles.topTitleWrap}>
              <MaoQiuIcon size={29} color="#FFFFFF" />
              <Text style={styles.topTitle}>{t('common.maoqiu')}</Text>
              <Text style={styles.topMeta}>
                {t('trash.itemCount', { count: totalCount })} · {unknownCount ? '≈ ' : ''}{sizeBytes > 0 ? formatBytes(sizeBytes) : '0 KB'}
              </Text>
            </View>
          </GlassPanel>
        </View>

        <View style={{ flex: 1 }} pointerEvents={deleting ? 'none' : 'auto'}>
          {previewIndex === null ? renderGrid() : renderPreview()}
        </View>
        {previewIndex === null && items.length > 0 ? (
          <View style={[styles.trashActionWrap, { bottom: insets.bottom + 16 }]} pointerEvents="box-none">
            {deleteNotice ? <Text style={styles.emptyHint} accessibilityLiveRegion="polite">{t('trash.emptyFailed')}</Text> : null}
            <Text style={styles.deleteHint}>{t('trash.recentlyDeletedHint')}</Text>
            <JellyPressable
              onPress={handleEmpty}
              disabled={deleting}
              accessibilityState={{ busy: deleting, disabled: deleting }}
              accessibilityLabel={deleting ? t('trash.emptyInProgress') : t('trash.deleteAll', { count: totalCount })}
            >
              <GlassPanel style={styles.trashAction} radius={26} intensity={58}>
                {deleting
                  ? <ActivityIndicator size="small" color={colors.text} />
                  : <Ionicons name="trash-outline" size={19} color={colors.danger} />}
                <Text style={styles.trashActionText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.65}>
                  {deleting ? t('trash.emptyInProgress') : t('trash.deleteAll', { count: totalCount })}
                </Text>
              </GlassPanel>
            </JellyPressable>
          </View>
        ) : null}
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000',
  },
  topBar: {
    paddingHorizontal: 14,
    paddingBottom: 8,
    zIndex: 50,
  },
  topBarInner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 10,
  },
  topBtn: {
    width: 46,
    height: 46,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 23,
  },
  topTitleWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  topTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '700',
  },
  topMeta: {
    color: colors.textMuted,
    fontSize: 12,
  },
  deleteHint: { color: colors.textMuted, fontSize: 12, textAlign: 'center', marginBottom: 10 },
  trashActionWrap: {
    position: 'absolute',
    left: 18,
    right: 18,
  },
  trashAction: {
    height: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
    backgroundColor: 'rgba(239, 68, 68, 0.22)',
  },
  trashActionText: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '700',
    flexShrink: 1,
  },
  gridContent: {
    paddingHorizontal: 4,
    paddingTop: 4,
  },
  cell: {
    margin: 2,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#15151A',
  },
  cellRestoreBtn: {
    position: 'absolute',
    top: 6,
    right: 6,
    zIndex: 99,
    elevation: 20,
  },
  cellRestoreInner: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(20, 22, 28, 0.88)',
  },
  cellImg: {
    flex: 1,
    width: '100%',
    height: '100%',
  },
  videoCoverBadge: {
    position: 'absolute',
    right: 7,
    bottom: 7,
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.48)',
  },
  emptyWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingBottom: 80,
  },
  emptyText: {
    color: colors.textMuted,
    fontSize: 14,
  },
  emptyHint: {
    color: colors.textMuted,
    fontSize: 12,
  },
  previewWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 30,
    backgroundColor: '#000',
  },
  previewSlide: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#000',
  },
  previewImg: {
    flex: 1,
    width: '100%',
    height: '100%',
  },
  previewVideo: {
    flex: 1,
    width: '100%',
    height: '100%',
  },
  previewDetails: {
    position: 'absolute',
    left: 18,
    right: 18,
    top: 88,
    paddingHorizontal: 15,
    paddingVertical: 12,
    gap: 4,
  },
  previewDetailsTitle: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '700',
  },
  previewDetailsText: {
    color: colors.textMuted,
    fontSize: 12,
  },
  previewRestoreWrap: {
    position: 'absolute',
    alignSelf: 'center',
  },
  previewRestore: {
    height: 46,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 20,
    justifyContent: 'center',
    backgroundColor: 'rgba(120, 80, 255, 0.30)',
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 4,
  },
  actionText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '700',
  },
});
