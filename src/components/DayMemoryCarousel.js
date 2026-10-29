import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, AppState, Easing, FlatList, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '../theme';
import { GlassPanel, JellyPressable } from './Glass';
import MemoryCard, { silenceAllPlayers } from './MemoryCard';
import VideoProgressControl from './VideoProgressControl';
import MaoQiuIcon from './MaoQiuIcon';
import * as ScreenOrientation from 'expo-screen-orientation';
import { useI18n } from '../i18n';
import { isVideoAsset } from '../media';
import useScrollLiveness from '../useScrollLiveness';

export default function DayMemoryCarousel({ items, initialIndex = 0, loading, onExit, onTrash, onPrepareTrash, onViewed, paused = false, onWindowIndexChange, onInteractionChange, constrained = false, onLoadBefore, onLoadAfter, hasBefore = false, hasAfter = false }) {
  const { width: winWidth, height: winHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const listRef = useRef(null);
  const [storedIndex, setActiveIndex] = useState(initialIndex);
  const [appActive, setAppActive] = useState(true);
  const [cardZoomed, setCardZoomed] = useState(false);
  const [scrolling, setScrolling] = useScrollLiveness();
  const [activeVideoPlayer, setActiveVideoPlayer] = useState(null);
  const [trashingId, setTrashingId] = useState(null);
  const isTrashingRef = useRef(false);
  useEffect(() => { onInteractionChange?.(scrolling); }, [scrolling, onInteractionChange]);
  const { t, formatLocalizedDate } = useI18n();

  // NATIVELY LOCK SCREEN TO PORTRAIT UP WHEN IN "回到那天" — RE-ENABLE UNLOCK ON EXIT
  useEffect(() => {
    try {
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
    } catch {}
    return () => {
      try {
        ScreenOrientation.unlockAsync();
      } catch {}
    };
  }, []);

  // IRON RULE: Silence all background audio on mount and during loading state
  useEffect(() => {
    silenceAllPlayers();
  }, []);

  useEffect(() => {
    if (loading) {
      silenceAllPlayers();
    }
  }, [loading]);

  const safeItems = Array.isArray(items) ? items : [];
  const contentAnchor = useRef({ items: null, id: null });
  const shiftedIndex = contentAnchor.current.items !== items && contentAnchor.current.id
    ? safeItems.findIndex(item => item.id === contentAnchor.current.id) : -1;
  const activeIndex = shiftedIndex >= 0 ? shiftedIndex : Math.min(storedIndex, Math.max(0, safeItems.length - 1));
  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;
  const activeVideoPlayerRef = useRef(activeVideoPlayer);
  activeVideoPlayerRef.current = activeVideoPlayer;
  const currentItem = safeItems[activeIndex] || safeItems[0] || null;
  contentAnchor.current = { items, id: currentItem?.id };
  useEffect(() => { onWindowIndexChange?.(activeIndex); }, [activeIndex, onWindowIndexChange]);
  useEffect(() => {
    if (activeIndex <= 8 && hasBefore) onLoadBefore?.();
    if (activeIndex >= safeItems.length - 9 && hasAfter) onLoadAfter?.();
  }, [activeIndex, safeItems.length, hasBefore, hasAfter, onLoadBefore, onLoadAfter]);

  // Lock layout dimensions to portrait proportions so landscape preview is disabled for "回到那天"
  const pWidth = Math.min(winWidth, winHeight);
  const pHeight = Math.max(winWidth, winHeight);

  const slotWidth = Math.round(pWidth * 0.75);
  const cardH = Math.round(pHeight * 0.72);
  const gap = 14;
  const interval = slotWidth + gap;
  const sideInset = Math.round((winWidth - slotWidth) / 2);

  // AppState tracking
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      setAppActive(next === 'active');
    });
    return () => sub.remove();
  }, []);

  const initialScrolledRef = useRef(false);

  // Scroll to initial index on mount only
  useEffect(() => {
    if (initialIndex > 0 && !initialScrolledRef.current && safeItems.length > initialIndex) {
      initialScrolledRef.current = true;
      requestAnimationFrame(() => {
        listRef.current?.scrollToOffset({
          offset: initialIndex * interval,
          animated: false,
        });
      });
    }
  }, [initialIndex, interval]);

  // Instantly silence active video player on exit
  const handleExit = useCallback(() => {
    if (isTrashingRef.current) return;
    silenceAllPlayers();
    if (activeVideoPlayerRef.current?.player) {
      try {
        activeVideoPlayerRef.current.player.muted = true;
        activeVideoPlayerRef.current.player.pause();
      } catch {}
    }
    setActiveVideoPlayer(null);
    onExit?.(activeIndexRef.current);
  }, [onExit]);

  // Guarantee audio silence on full unmount
  useEffect(() => {
    return () => {
      silenceAllPlayers();
      if (activeVideoPlayerRef.current?.player) {
        try {
          activeVideoPlayerRef.current.player.muted = true;
          activeVideoPlayerRef.current.player.pause();
        } catch {}
      }
      setActiveVideoPlayer(null);
    };
  }, []);

  // Reconcile the stored index BEFORE paint; render itself already anchors by ID.
  useLayoutEffect(() => {
    if (activeIndex !== storedIndex) {
      setActiveIndex(activeIndex);
      listRef.current?.scrollToOffset({ offset: activeIndex * interval, animated: false });
    }
  }, [activeIndex, storedIndex, interval]);

  // Handle scroll offset to determine active card index (STABLE callback, zero infinite loops)
  const onScroll = useCallback(
    (e) => {
      const x = e.nativeEvent.contentOffset.x;
      if (interval <= 0) return;
      const idx = Math.min(Math.max(Math.round(x / interval), 0), safeItems.length - 1);
      if (idx !== activeIndexRef.current) {
        activeIndexRef.current = idx;
        silenceAllPlayers();
        setActiveIndex(idx);
        setActiveVideoPlayer(null);
      }
    },
    [interval, safeItems.length]
  );

  const handleVideoPlayerChange = useCallback((index, playerObj) => {
    if (index === activeIndexRef.current) {
      setActiveVideoPlayer((prev) => {
        if (!playerObj && !prev) return null;
        if (prev?.player === playerObj?.player && prev?.id === playerObj?.id) return prev;
        return playerObj;
      });
    }
  }, []);

  const prepareDayTrash = useCallback(async item => {
    if (isTrashingRef.current || paused) return false;
    isTrashingRef.current = true;
    setTrashingId(item.id);
    silenceAllPlayers();
    let allowed = false;
    try { allowed = await onPrepareTrash?.(item); } catch {}
    if (!allowed) { isTrashingRef.current = false; setTrashingId(null); }
    return allowed;
  }, [onPrepareTrash, paused]);

  const handleCardTrash = useCallback(
    (targetItem) => {
      const itemToTrash = targetItem || currentItem;
      if (!itemToTrash) return;
      if (activeVideoPlayerRef.current?.player) {
        try {
          activeVideoPlayerRef.current.player.muted = true;
          activeVideoPlayerRef.current.player.pause();
        } catch {}
      }
      setActiveVideoPlayer(null);
      setCardZoomed(false);
      onTrash?.(itemToTrash);
      isTrashingRef.current = false;
      setTrashingId(null);
    },
    [currentItem, onTrash]
  );

  const handleFavChange = useCallback(() => {}, []);

  const trashAnim = useRef(new Animated.Value(0)).current;
  const btnPulse = useRef(new Animated.Value(1)).current;

  const cardFlyScale = trashAnim.interpolate({
    inputRange: [0, 0.55, 1],
    outputRange: [1, 0.5, 0.08],
  });
  const cardFlyTranslateY = trashAnim.interpolate({
    inputRange: [0, 0.55, 1],
    outputRange: [0, 90, 260],
  });
  const cardFlyRotate = trashAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '-14deg'],
  });
  const cardFlyOpacity = trashAnim.interpolate({
    // Stay fully visible while it shrinks and falls, then fade out only at the
    // very end so it reads as "dropped into the capsule" instead of a flash.
    inputRange: [0, 0.6, 0.85, 1],
    outputRange: [1, 1, 1, 0],
  });

  const pendingTrashIdsRef = useRef(new Set());

  const handleTrashCurrent = useCallback(async () => {
    const availableItems = safeItems.filter((it) => it && !pendingTrashIdsRef.current.has(it.id));
    if (availableItems.length === 0) return;

    const targetItem = availableItems.find((it) => it.id === currentItem?.id) || availableItems[0];
    if (!targetItem) return;

    if (!(await prepareDayTrash(targetItem))) return;
    pendingTrashIdsRef.current.add(targetItem.id);
    try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}

    if (activeVideoPlayerRef.current?.player) {
      try {
        activeVideoPlayerRef.current.player.muted = true;
        activeVideoPlayerRef.current.player.pause();
      } catch {}
    }
    setActiveVideoPlayer(null);
    setCardZoomed(false);

    // Play the "card flies into the Hairball" animation FIRST so the user can
    // see it. The item is only marked as trashed (which is what bumps the
    // Hairball count / persists) once the flight has finished — exactly once,
    // via handleCardTrash -> parent onTrash. Moving it immediately instead
    // would unmount the card before a single animation frame is drawn.
    Animated.parallel([
      Animated.timing(trashAnim, {
        toValue: 1,
        duration: 240,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.sequence([
        Animated.timing(btnPulse, { toValue: 1.25, duration: 110, useNativeDriver: true }),
        Animated.timing(btnPulse, { toValue: 1.0, duration: 130, useNativeDriver: true }),
      ]),
    ]).start(() => {
      trashAnim.setValue(0);
      setTrashingId(null);
      pendingTrashIdsRef.current.delete(targetItem.id);
      handleCardTrash(targetItem);
      isTrashingRef.current = false;
    });
  }, [safeItems, currentItem, handleCardTrash, trashAnim, btnPulse, prepareDayTrash]);

  const getItemLayout = useCallback(
    (_, index) => ({ length: interval, offset: interval * index, index }),
    [interval]
  );

  return (
    <View style={styles.container}>
      {/* Top Header */}
      <View style={[styles.topHeader, { top: insets.top + 10 }]}>
        <JellyPressable onPress={handleExit} hitSlop={10}>
          <GlassPanel style={styles.headerBtn} radius={23} intensity={50}>
            <Ionicons name="arrow-back" size={20} color="#FFFFFF" />
          </GlassPanel>
        </JellyPressable>

        <GlassPanel style={styles.dateBadge} radius={23} intensity={50}>
          <Ionicons name="calendar-outline" size={16} color="#FFFFFF" />
          <Text style={styles.dateText}>{formatLocalizedDate(currentItem?.creationTime) || t('dayCarousel.title')}</Text>
          <Text style={styles.counterText}>{`${activeIndex + 1}/${safeItems.length}`}</Text>
        </GlassPanel>

        <View style={{ width: 46 }} />
      </View>

      {/* Main Stream or Loading */}
      {loading ? (
        <View style={styles.loadingWrap}>
          <GlassPanel style={styles.loadingCard} radius={24} intensity={60}>
            <ActivityIndicator size="large" color="#FFFFFF" />
            <Text style={styles.loadingTitle}>{t('dayCarousel.loadingTitle') || '正在检索同日相册...'}</Text>
            <Text style={styles.loadingSubtitle}>{t('dayCarousel.loadingSub') || '正在查找当天拍摄的所有照片与视频'}</Text>
          </GlassPanel>
        </View>
      ) : safeItems.length === 0 ? (
        <View style={styles.loadingWrap}>
          <GlassPanel style={styles.loadingCard} radius={24} intensity={60}>
            <Ionicons name="images-outline" size={32} color="rgba(255,255,255,0.6)" />
            <Text style={styles.loadingTitle}>{t('dayCarousel.empty')}</Text>
          </GlassPanel>
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={safeItems}
          keyExtractor={(item, idx) => item.id || `day-item-${idx}`}
          horizontal
          pagingEnabled={false}
          snapToInterval={interval}
          decelerationRate="fast"
          disableIntervalMomentum
          scrollEnabled={!cardZoomed && !trashingId && !paused}
          showsHorizontalScrollIndicator={false}
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: sideInset, alignItems: 'center' }}
          onScroll={onScroll}
          onScrollBeginDrag={() => { silenceAllPlayers(); setScrolling(true); }}
          onMomentumScrollEnd={() => setScrolling(false)}
          onScrollEndDrag={event => { if (Math.abs(event.nativeEvent.velocity?.x || 0) < 0.1) setScrolling(false); }}
          scrollEventThrottle={16}
          getItemLayout={getItemLayout}
          initialScrollIndex={initialIndex}
          renderItem={({ item, index }) => {
            const isActive = index === activeIndex;
            const isDeletingCurrent = isActive && (isTrashingRef.current || trashingId === item.id);
            const isVideo = isVideoAsset(item);
            const isLive = Boolean(item.isLive);
            return (
              <View style={[{ width: slotWidth, height: cardH, justifyContent: 'center', alignItems: 'center' }, index < safeItems.length - 1 && { marginRight: 14 }]}>
                <Animated.View
                  style={[
                    styles.cardContainer,
                    isDeletingCurrent
                      ? {
                          opacity: cardFlyOpacity,
                          transform: [
                            { translateY: cardFlyTranslateY },
                            { scale: cardFlyScale },
                            { rotate: cardFlyRotate },
                          ],
                        }
                      : null,
                  ]}
                >
                  <MemoryCard
                    item={item}
                    items={[item]}
                    height={cardH}
                    maxWidth={slotWidth}
                    showAmbient={false}
                    active={isActive && appActive && !scrolling && !paused}
                    onMediaReady={onViewed}
                    preload={Math.abs(index - activeIndex) <= 1}
                    retainPlayer={isActive && appActive && !paused}
                    constrained={constrained}
                    videoPreload={!constrained && index === activeIndex + 1 && appActive && !paused}
                    onPrepareTrash={prepareDayTrash}
                    onTrash={() => handleCardTrash(item)}
                    onFavoriteChange={handleFavChange}
                    onZoomStateChange={setCardZoomed}
                    onVideoPlayerChange={(pObj) => handleVideoPlayerChange(index, pObj)}
                    allowFeedGestures={false}
                    showInfo={false}
                    showTypeBadge={true}
                  />
                </Animated.View>
              </View>
            );
          }}
          windowSize={3}
          initialNumToRender={3}
          maxToRenderPerBatch={3}
          removeClippedSubviews={false}
        />
      )}

      {/* Video Progress Control — video-only. MemoryCard tags live-photo
          players with `live: true`; a Live Photo is a looping motion clip,
          not a timeline video, so it must never get the scrub bar. */}
      {activeVideoPlayer?.player && !activeVideoPlayer.live ? (
        <VideoProgressControl
          player={activeVideoPlayer.player}
          bottom={insets.bottom + 68}
        />
      ) : null}

      {/* Bottom Bar */}
      <View style={[styles.bottomBar, { bottom: insets.bottom + 12 }]} pointerEvents="box-none">
        <JellyPressable onPress={handleTrashCurrent} hitSlop={10}>
          <Animated.View style={{ transform: [{ scale: btnPulse }] }}>
            <GlassPanel style={styles.trashBtn} radius={23} intensity={65}>
              <MaoQiuIcon size={29} color={colors.white} />
              <Text style={styles.trashText}>{t('dayCarousel.moveToMaoqiuBtn')}</Text>
            </GlassPanel>
          </Animated.View>
        </JellyPressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  cardContainer: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  cardTypeBadgeWrap: {
    position: 'absolute',
    top: 14,
    left: 14,
    zIndex: 15,
  },
  cardTypeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    backgroundColor: 'rgba(20, 22, 28, 0.65)',
    borderColor: 'rgba(255, 255, 255, 0.25)',
  },
  cardTypeBadgeText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  loadingWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingCard: {
    paddingHorizontal: 28,
    paddingVertical: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.28)',
    backgroundColor: 'rgba(20, 22, 28, 0.75)',
    shadowColor: '#000000',
    shadowOpacity: 0.35,
    shadowRadius: 20,
    elevation: 10,
  },
  loadingTitle: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
    marginTop: 8,
    letterSpacing: 0.6,
  },
  loadingSubtitle: {
    color: 'rgba(255, 255, 255, 0.65)',
    fontSize: 13,
    fontWeight: '500',
    marginTop: 4,
  },
  topHeader: {
    position: 'absolute',
    left: 18,
    right: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    zIndex: 20,
  },
  headerBtn: {
    width: 46,
    height: 46,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dateBadge: {
    paddingHorizontal: 16,
    height: 46,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  dateText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  counterText: {
    color: 'rgba(255, 255, 255, 0.65)',
    fontSize: 12,
    fontWeight: '600',
  },
  bottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 46,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 20,
  },
  trashBtn: {
    height: 46,
    paddingHorizontal: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(120, 80, 255, 0.30)',
  },
  trashText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
});
