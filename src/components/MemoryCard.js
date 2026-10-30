import { SWIPE_COMMIT } from '../gestureContract.mjs';
import { MOTION, beginMotionDrag, moveMotionDrag, exitMotion, fadeMotion, settleMotion, useReducedMotion } from '../motion';
import useBurstMotion from '../useBurstMotion';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  AppState,
  Easing,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { Image as ExpoImage } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';
import { LinearGradient } from 'expo-linear-gradient';
import * as FileSystem from 'expo-file-system/legacy';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { colors, formatBytes } from '../theme';
import {
  getPlaceName,
  getDisplayUri,
  getSandboxMediaUri,
  getUriFallback,
  isVideoAsset,
  reportMediaDisplayFailure,
  loadItemBasics,
  loadExif,
  loadLivePhotoUri,
  getAssetSizeBytes,
  toggleFavorite,
  isItemFavorite,
} from '../media';
import PhotoKitPreview from './PhotoKitPreview';
import { supportsNativePhotoPreview } from '../nativePhotoPreview';
import { getRenderableImageUri, formatGpsCoordinate } from '../mediaPage.mjs';
import { GlassPanel } from './Glass';
import AmbientBackdrop from './AmbientBackdrop';
import MaoQiuIcon from './MaoQiuIcon';
import { useI18n } from '../i18n';
import { photoCardSize } from '../mediaWindow.mjs';

/**
 * 交互底层规则（抖音式信息流 · 按内容类型）：
 *
 *  类型          单击          长按(400ms)        双指缩放           左滑             右滑
 *  ──────────────────────────────────────────────────────────────────────────────────────
 *  视频          暂停/恢复      2 倍速(按住)       不支持             删除 → 下一张      收藏/取消收藏
 *  单张实况      无            无                  支持 1x~4x        同左              同左
 *  单张静态照片  无            无                 支持 1x~4x + 平移   同左              同左
 *  连拍组        切下一帧(循环) 按当前帧类型生效     支持(当前帧)       删除当前帧 → 下一张  收藏/取消当前帧
 *                             (仅视频 2x；实况、照片无)
 *
 * 自动播放：视频/实况 = 有声循环；静态照片 = Ken Burns 微运镜；连拍组 = 手动切换（无自动推进）。
 * 上滑/下滑：所有类型统一为 FlatList 分页换条（pagingEnabled）。对角线一律锁为纵向；横滑仅在
 * 横向位移达到纵向 1.35 倍、纵向漂移不超过 34px 时独占触摸，直到抬手才恢复列表滚动。
 * 声音纪律：非 active 卡片一律 pause + muted（原生属性立即生效），
 * 播放器创建时默认静音，只有当前活动卡会解除静音并播放；滚动开始即静音。
 * 手势纪律：拖动/捏合/平移开始（onPanResponderGrant）0ms 全员静音（PRD 5.2，
 * 含尚未判定方向的拖动）；手势取消或未提交删除时立即恢复本卡播放。
 */
// Keep tutorial and real-photo commit distance identical.

const MAX_ZOOM = 4;
const LONG_PRESS_MS = 400;
const DIRECTION_LOCK_DISTANCE = 12;
const HORIZONTAL_ACTIVATE = 12;
const HORIZONTAL_DOMINANCE = 1.15;
const MAX_SWIPE_VERTICAL_DRIFT = 75;
// Burst frame prefetch: eager window around the visible frame + low-priority
// backfill cadence for the rest of the deck (see the prefetch effect below).
const BURST_PREFETCH_RADIUS = 2;
// Poster thumbnails only back a full-screen surface (393pt @3x ≈ 1179px), so
// a 4K/8K video must not produce a full-resolution keyframe bitmap.
const VIDEO_THUMB_OPTIONS = { time: 0, maxWidth: 1200 };
// High-contrast alternating sequence for burst sequences: 红, 黄, 蓝, 橙, 绿, 紫, 青
const BURST_RAINBOW_BORDER_COLORS = [
  'rgba(255, 59, 92, 0.88)',   // 1. 红 (Vibrant Coral Red)
  'rgba(255, 204, 0, 0.88)',   // 2. 黄 (Bright Warm Yellow)
  'rgba(0, 153, 255, 0.88)',   // 3. 蓝 (Electric Blue)
  'rgba(255, 136, 0, 0.88)',   // 4. 橙 (Tangerine Orange)
  'rgba(0, 208, 108, 0.88)',   // 5. 绿 (Emerald Green)
  'rgba(176, 64, 255, 0.88)',  // 6. 紫 (Electric Purple)
  'rgba(0, 223, 223, 0.88)',   // 7. 青 (Bright Cyan)
];

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
}

// First-frame thumbnails for video cards (player-independent, so preloaded
// cards always have a visible backdrop even before a player is created).
const videoThumbCache = new LRUMap(50);
const savedPlaybackPositions = new LRUMap(50);
const activePlayersSet = new Set();
let currentAudioPlayer = null;

function silencePlayer(player) {
  if (!player) return;
  try {
    if (player.muted !== true) player.muted = true;
    if (player.volume !== 0) player.volume = 0;
    if (player.playing) player.pause();
  } catch {}
}

export function silenceAllPlayers() {
  activePlayersSet.forEach((p) => {
    silencePlayer(p);
  });
  if (currentAudioPlayer) {
    silencePlayer(currentAudioPlayer);
    currentAudioPlayer = null;
  }
}

function safePlayPlayer(player, targetVolume = 1.0) {
  if (!player) return;
  try {
    // Mute and pause ALL other players in activePlayersSet to prevent any audio overlap
    activePlayersSet.forEach((p) => {
      if (p !== player) {
        silencePlayer(p);
      }
    });
    currentAudioPlayer = player;
    activePlayersSet.add(player);

    if (Math.abs((player.volume ?? 1) - targetVolume) > 0.01) {
      player.volume = targetVolume;
    }
    if (player.muted !== false) {
      player.muted = false;
    }
    if (!player.playing) {
      player.play();
    }
  } catch {}
}

function imageUri(uri) {
  return getRenderableImageUri(uri, Platform.OS !== 'ios');
}

function pinchDist(e) {
  const t = e.nativeEvent.touches;
  if (!t || t.length < 2) return 0;
  const dx = t[0].pageX - t[1].pageX;
  const dy = t[0].pageY - t[1].pageY;
  return Math.sqrt(dx * dx + dy * dy);
}

function formatDateShort(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function formatDateTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function exifValue(exif, ...keys) {
  for (const key of keys) {
    const value = exif?.[key];
    if (value !== undefined && value !== null && value !== '') return String(value);
  }
  return '';
}

function DetailLine({ icon, children }) {
  return (
    <View style={styles.detailLine}>
      <Ionicons name={icon} size={13} color={colors.textMuted} />
      <Text style={styles.detailText}>{children}</Text>
    </View>
  );
}

function formatVideoTime(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

function MemoryVideo({ uri, playing, loop = true, onEnd, onFinish, onLoading, onDuration, rate = 1, onFirstFrame, style, showProgress, controlsActive, onPlayerChange, showView = true }) {
  const player = useVideoPlayer(uri, (p) => {
    try { p.loop = loop; } catch {}
    try { p.muted = true; } catch {}
  });
  const [status, setStatus] = useState(() => {
    try { return player.status; } catch { return 'idle'; }
  });
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const firstFrameRef = useRef(false);
  const scrubbingRef = useRef(false);
  const trackWidthRef = useRef(0);
  const hasRestoredTimeRef = useRef(false);

  const restoreSavedPosition = useCallback(() => {
    if (hasRestoredTimeRef.current || !uri) return;
    const savedTime = savedPlaybackPositions.get(uri);
    if (typeof savedTime === 'number' && savedTime > 0.05) {
      try {
        player.currentTime = savedTime;
        setPosition(savedTime);
        hasRestoredTimeRef.current = true;
      } catch {}
    }
  }, [player, uri]);

  const updateScrubPosition = useCallback(
    (locationX) => {
      const width = trackWidthRef.current;
      const next = duration > 0 && width > 0 ? Math.min(Math.max(locationX / width, 0), 1) * duration : 0;
      setPosition(next);
      return next;
    },
    [duration]
  );

  const scrubResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (event) => {
          scrubbingRef.current = true;
          try { player.pause(); } catch {}
          updateScrubPosition(event.nativeEvent.locationX);
        },
        onPanResponderMove: (event) => updateScrubPosition(event.nativeEvent.locationX),
        onPanResponderRelease: (event) => {
          const next = updateScrubPosition(event.nativeEvent.locationX);
          try { player.currentTime = next; } catch {}
          savedPlaybackPositions.set(uri, next);
          scrubbingRef.current = false;
          if (playing) {
            try { player.muted = false; } catch {}
            try { player.play(); } catch {}
          }
        },
        onPanResponderTerminate: () => {
          scrubbingRef.current = false;
          if (playing) {
            try { player.play(); } catch {}
          }
        },
      }),
    [player, playing, updateScrubPosition, uri]
  );

  useEffect(() => {
    try {
      if (player.playbackRate !== rate) player.playbackRate = rate;
    } catch {}
  }, [rate, player]);

  useEffect(() => {
    let cur = 'idle';
    try { cur = player.status; } catch {}
    if (cur !== status) setStatus(cur);
    if (cur === 'readyToPlay') {
      try {
        onDuration?.(player.duration);
        setDuration(player.duration || 0);
      } catch {}
      restoreSavedPosition();
    }
    let sub = null;
    try {
      sub = player.addListener('statusChange', ({ status: s }) => {
        setStatus(s);
        if (s === 'readyToPlay') {
          try {
            onDuration?.(player.duration);
            setDuration(player.duration || 0);
          } catch {}
          restoreSavedPosition();
          if (playing) safePlayPlayer(player);
        } else {
          onLoading?.();
        }
        if (s === 'error') {
          // Error entry must cut audio synchronously too (PRD 5.2) — the
          // native player usually stops itself, but never rely on it.
          silencePlayer(player);
          if (playing) onEnd();
        }
      });
    } catch {}
    return () => {
      try { sub?.remove(); } catch {}
    };
  }, [player, playing, onEnd, onLoading, onDuration, uri, restoreSavedPosition]);

  useEffect(() => {
    let sub = null;
    try {
      // 2 updates/sec, not 5: this listener exists to persist the resume
      // position (0.5s granularity is plenty) — each tick is a bridge event.
      player.timeUpdateEventInterval = 0.5;
      sub = player.addListener('timeUpdate', ({ currentTime }) => {
        if (currentTime > 0) {
          savedPlaybackPositions.set(uri, currentTime);
        }
        if (showProgress && !scrubbingRef.current) setPosition(currentTime || 0);
      });
    } catch {}
    return () => {
      try { sub?.remove(); } catch {}
    };
  }, [player, uri, showProgress]);

  const onPlayerChangeRef = useRef(onPlayerChange);
  useEffect(() => {
    onPlayerChangeRef.current = onPlayerChange;
  }, [onPlayerChange]);

  useEffect(() => {
    if (!onPlayerChangeRef.current) return undefined;
    if (status !== 'readyToPlay' || !controlsActive) {
      onPlayerChangeRef.current(null);
      return undefined;
    }
    onPlayerChangeRef.current(player);
    return () => {
      try { onPlayerChangeRef.current?.(null); } catch {}
    };
  }, [controlsActive, player, status]);

  useEffect(() => {
    if (player) activePlayersSet.add(player);
    return () => {
      if (player) {
        silencePlayer(player);
        activePlayersSet.delete(player);
      }
      // Player is being destroyed — safe to clear the pointer here (component unmount)
      if (currentAudioPlayer === player) currentAudioPlayer = null;
    };
  }, [player]);

  useEffect(() => {
    if (!playing || status !== 'readyToPlay') {
      silencePlayer(player);
      return;
    }

    // Silence EVERY other active player in activePlayersSet
    activePlayersSet.forEach((p) => {
      if (p !== player) {
        silencePlayer(p);
      }
    });
    currentAudioPlayer = player;
    activePlayersSet.add(player);

    // Use a cancelled flag to prevent ghost callbacks causing AVFoundation buffer flushes
    let cancelled = false;
    let timer = null;

    // Set audio properties synchronously before RAF — no buffer flush risk
    try { if (player.muted !== false) player.muted = false; } catch {}
    try { if (Math.abs((player.volume ?? 1) - 1.0) > 0.01) player.volume = 1.0; } catch {}

    const raf = requestAnimationFrame(() => {
      if (cancelled) return;
      try { if (!player.playing) player.play(); } catch {}
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
      try {
        if (typeof player.currentTime === 'number' && player.currentTime > 0) {
          savedPlaybackPositions.set(uri, player.currentTime);
        }
      } catch {}
      silencePlayer(player);
      // Do NOT null-out currentAudioPlayer here — let safePlayPlayer on next card handle the handoff.
      // Nulling here causes a race: if next card's effect runs before this cleanup, it skips silencing the old player.
    };
  }, [playing, status, player, uri]);

  useEffect(() => {
    let sub = null;
    try {
      sub = AppState.addEventListener('change', (nextState) => {
        if (nextState !== 'active') {
          silencePlayer(player);
          if (currentAudioPlayer === player) currentAudioPlayer = null;
        } else if (playing && status === 'readyToPlay') {
          if (currentAudioPlayer && currentAudioPlayer !== player) {
            silencePlayer(currentAudioPlayer);
          }
          currentAudioPlayer = player;
          try { player.muted = false; } catch {}
          try { player.play(); } catch {}
        }
      });
    } catch {}
    return () => {
      try { sub?.remove(); } catch {}
    };
  }, [player, playing, status]);

  useEffect(() => {
    let sub = null;
    try {
      sub = player.addListener('playToEnd', () => {
        if (loop) {
          try { player.replay(); } catch {}
        } else {
          onFinish?.();
        }
      });
    } catch {}
    return () => {
      try { sub?.remove(); } catch {}
    };
  }, [player, loop, onFinish]);

  useEffect(() => {
    if (!playing) return;
    const t = setTimeout(() => {
      if (status !== 'readyToPlay' || !firstFrameRef.current) {
        onEnd();
      }
    }, 10000);
    return () => clearTimeout(t);
  }, [playing, status, onEnd, uri]);

  if (status !== 'readyToPlay' || !showView) return null;
  const progress = duration > 0 ? Math.min(Math.max(position / duration, 0), 1) : 0;
  return (
    <>
      <VideoView
        player={player}
        style={style || styles.coverFill}
        contentFit="contain"
        nativeControls={false}
        pointerEvents="none"
        allowsVideoFrameAnalysis={false}
        onFirstFrameRender={() => {
          firstFrameRef.current = true;
          onFirstFrame?.();
        }}
      />
      {showProgress && duration > 0 ? (
        <View style={styles.videoProgressWrap} pointerEvents="box-none">
          <View
            style={styles.videoProgressTrack}
            onLayout={(event) => {
              trackWidthRef.current = event.nativeEvent.layout.width;
            }}
            {...scrubResponder.panHandlers}
          >
            <View style={styles.videoProgressBase} pointerEvents="none" />
            <View style={[styles.videoProgressFill, { width: `${progress * 100}%` }]} />
            <View style={[styles.videoProgressThumb, { left: `${progress * 100}%` }]} />
          </View>
          <Text style={styles.videoProgressTime}>{`${formatVideoTime(position)} / ${formatVideoTime(duration)}`}</Text>
        </View>
      ) : null}
    </>
  );
}

function LivePhotoVideo({ uri, playing, loop = true, onEnd, onDuration, style, onPlayerChange }) {
  const player = useVideoPlayer(uri, (p) => {
    try { p.loop = loop; } catch {}
    try { p.muted = true; } catch {}
    try { p.volume = 0; } catch {}
  });
  const [status, setStatus] = useState(() => {
    try { return player.status; } catch { return 'idle'; }
  });

  useEffect(() => {
    if (player) activePlayersSet.add(player);
    return () => {
      if (player) {
        silencePlayer(player);
        activePlayersSet.delete(player);
      }
      if (currentAudioPlayer === player) currentAudioPlayer = null;
    };
  }, [player]);

  // Report the player upward so MemoryCard can resume audio directly after a
  // gesture that was silenced at grant time but ended without leaving the card.
  const onPlayerChangeRef = useRef(onPlayerChange);
  useEffect(() => {
    onPlayerChangeRef.current = onPlayerChange;
  }, [onPlayerChange]);

  useEffect(() => {
    if (!onPlayerChangeRef.current) return undefined;
    if (status !== 'readyToPlay') {
      onPlayerChangeRef.current(null);
      return undefined;
    }
    onPlayerChangeRef.current(player);
    return () => {
      try { onPlayerChangeRef.current?.(null); } catch {}
    };
  }, [player, status]);

  // Live Photos have AUDIO via the single-audio-interlock (safePlayPlayer).
  // safePlayPlayer silences any previously active player (video or live photo)
  // and registers this player as currentAudioPlayer.
  // The effect cleanup runs SYNCHRONOUSLY when playing→false (card swiped away),
  // immediately silencing via silencePlayer — zero audio bleed.
  useEffect(() => {
    if (!playing || status !== 'readyToPlay') {
      // Immediate silence on swipe-away — do NOT null currentAudioPlayer (let next card's safePlayPlayer handle handoff)
      silencePlayer(player);
      return;
    }
    // Play with audio — participates in the global audio interlock
    let cancelled = false;
    try {
      activePlayersSet.forEach((p) => {
        if (p !== player) {
          silencePlayer(p);
        }
      });
      currentAudioPlayer = player;
      activePlayersSet.add(player);
      // Set audio properties synchronously before RAF
      if (player.muted !== false) player.muted = false;
      if (Math.abs((player.volume ?? 1) - 1.0) > 0.01) player.volume = 1.0;
    } catch {}

    const raf = requestAnimationFrame(() => {
      if (cancelled) return;
      try { if (!player.playing) player.play(); } catch {}
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      silencePlayer(player);
      // Do NOT null-out currentAudioPlayer here — let safePlayPlayer on next card handle the handoff.
    };
  }, [playing, status, player]);

  useEffect(() => {
    let statusSub = null;
    let endSub = null;
    try {
      statusSub = player.addListener('statusChange', ({ status: s }) => {
        setStatus(s);
        if (s === 'readyToPlay') {
          try { onDuration?.(player.duration); } catch {}
          if (playing) safePlayPlayer(player, 1.0);
        }
      });
    } catch {}
    try {
      endSub = player.addListener('playToEnd', () => {
        if (loop) {
          try { player.replay(); } catch {}
        } else {
          onEnd?.();
        }
      });
    } catch {}
    // Sync initial status on mount
    let cur = 'idle';
    try { cur = player.status; } catch {}
    if (cur !== status) setStatus(cur);
    if (cur === 'readyToPlay') {
      try { onDuration?.(player.duration); } catch {}
    }
    return () => {
      try { statusSub?.remove(); } catch {}
      try { endSub?.remove(); } catch {}
    };
  }, [player, loop, onEnd, onDuration, playing]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!playing || status !== 'readyToPlay') return null;
  return (
    <VideoView
      player={player}
      style={style || styles.coverFill}
      contentFit="contain"
      nativeControls={false}
      pointerEvents="none"
    />
  );
}

function MemoryCard({
  item,
  items,
  active,
  preload,
  videoPreload = false,
  retainPlayer = active,
  constrained = false,
  onAdvance,
  onTrash,
  onPrepareTrash,
  onFavoriteChange,
  onMediaReady,
  height,
  maxWidth,
  showAmbient = true,
  groupIndex = 0,
  groupCount = 1,
  onGroupNext,
  onZoomStateChange,
  onPinchIn,
  onVideoPlayerChange,
  onHorizontalGestureChange,
  allowFeedGestures = true,
  showInfo = true,
  showTypeBadge = false,
  purpose = 'feed',
}) {
  const insets = useSafeAreaInsets();
  const { width: winWidth } = useWindowDimensions();
  const { t } = useI18n();
  const reduceMotion = useReducedMotion();

  const isVideo = isVideoAsset(item);
  const isLive = !!item?.isLive;

  const [playing, setPlaying] = useState(true);
  const [fav, setFav] = useState(() => isItemFavorite(item));
  const [place, setPlace] = useState(item?.placeName || '');
  const [placeShort, setPlaceShort] = useState(item?.placeShortName || '');
  const [infoExpanded, setInfoExpanded] = useState(false);
  const [infoExif, setInfoExif] = useState(null);
  const [infoSize, setInfoSize] = useState(null);
  const [liveUri, setLiveUri] = useState(item.livePhotoUri || null);
  const [videoFirstFrame, setVideoFirstFrame] = useState(false);
  const [displayedMediaId, setDisplayedMediaId] = useState(null);
  const [videoThumb, setVideoThumb] = useState(null);
  const [ambientPhotoUri, setAmbientPhotoUri] = useState(null);
  const [stillStep, setStillStep] = useState(0);
  const [fallbackUri, setFallbackUri] = useState(null);
  const [burstBackdropUri, setBurstBackdropUri] = useState(null);
  const burstBackdropAnchorRef = useRef(null);
  const [renderedStep, setRenderedStep] = useState(-1);
  const [showLoadingSpinner, setShowLoadingSpinner] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [videoRate, setVideoRate] = useState(1);

  useEffect(() => {
    if (active && displayedMediaId === item?.id) onMediaReady?.(item);
  }, [active, displayedMediaId, item?.id, onMediaReady]);
  const burstDirectionRef = useRef(0);

  const translateX = useRef(new Animated.Value(0)).current;
  const favBurst = useRef(new Animated.Value(0)).current;
  const zoomScale = useRef(new Animated.Value(1)).current;
  const zoomPanX = useRef(new Animated.Value(0)).current;
  const zoomPanY = useRef(new Animated.Value(0)).current;
  const pop = useRef(new Animated.Value(1)).current;

  const isBurst = groupCount > 1;
  const burstPoses = useBurstMotion({
    itemId: item?.id, enabled: isBurst && (active || preload),
    directionRef: burstDirectionRef, reduced: reduceMotion || constrained,
  });
  // Color is bound to the photo's stable in-group index (burstIndex), NOT the
  // viewing position (groupIndex), so each frame keeps its color across
  // frame switches, back-swipe review and feed rebuilds.
  const burstBorderColor = isBurst && groupCount > 1
    ? BURST_RAINBOW_BORDER_COLORS[(item.burstIndex ?? groupIndex) % BURST_RAINBOW_BORDER_COLORS.length]
    : null;
  const canZoom = !isVideo;
  // Media-first chrome for bursts: the colored wireframe (front border +
  // fanned stack deck) must never appear before the photo under it can be
  // shown, otherwise a fast swipe or a return from "回到那一天" renders a
  // moment of empty colored frames. renderedStep flips to >= 0 when the front
  // still actually decodes; stillStep 3 means every decode attempt failed and
  // the "无法显示" text is shown — reveal the chrome there too so the frame
  // never looks half-built. During in-group frame switches renderedStep stays
  // >= 0, so the chrome persists continuously without re-fading.
  const burstChromeReady = renderedStep !== -1 || stillStep === 3;
  const burstDeckReveal = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!burstChromeReady) {
      burstDeckReveal.setValue(0);
      return undefined;
    }
    // On first reveal this animates 0 → 1; on later frame switches the value
    // is already 1, so re-running is a visual no-op (no flash).
    const anim = Animated.timing(burstDeckReveal, {
      toValue: 1,
      duration: reduceMotion ? MOTION.reducedMs : MOTION.fadeMs,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
      isInteraction: false,
    });
    anim.start();
    return () => anim.stop();
  }, [item?.id, burstChromeReady, burstDeckReveal, reduceMotion]);
  // Player of the CURRENT card (video or live photo), kept so a gesture that
  // silenced audio at grant time can resume it when it ends without leaving.
  const cardPlayerRef = useRef(null);
  const handleVideoPlayerChange = useCallback(
    (player) => {
      cardPlayerRef.current = player || null;
      onVideoPlayerChange?.({ id: item.id, player: player || null });
    },
    [item.id, onVideoPlayerChange]
  );
  // Live photos share the same player-reporting channel so the 0ms mute/resume
  // interlock keeps working, but they must NOT get the scrub progress bar —
  // tag them so HomeScreen can tell the two apart.
  const handleLivePlayerChange = useCallback(
    (player) => {
      cardPlayerRef.current = player || null;
      onVideoPlayerChange?.({ id: item.id, player: player || null, live: true });
    },
    [item.id, onVideoPlayerChange]
  );

  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  const playingRef = useRef(playing);
  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);

  // True between a gesture grant (which silenced everyone) and its release.
  const gestureMuteRef = useRef(false);
  // PRD 5.2 counterpart: the gesture ended WITHOUT committing a delete, so the
  // card is still the current content — resume its audio immediately.
  const resumeGestureAudio = useCallback(() => {
    gestureMuteRef.current = false;
    if (!activeRef.current || !playingRef.current) return;
    const player = cardPlayerRef.current;
    if (player) safePlayPlayer(player);
  }, []);

  const zoomedRef = useRef(false);
  const zoomStateRef = useRef({
    mode: 'none',
    scale: 1,
    panX: 0,
    panY: 0,
    baseDist: 1,
    baseScale: 1,
    basePanX: 0,
    basePanY: 0,
    canZoom,
  });
  zoomStateRef.current.canZoom = canZoom;
  const longPressRef = useRef(null);
  const gestureDirectionRef = useRef('idle');
  const horizontalGestureRef = useRef(false);
  const onPinchInRef = useRef(onPinchIn);

  useEffect(() => {
    onPinchInRef.current = onPinchIn;
  }, [onPinchIn]);

  // Preparing a neighbouring video is independent of playback ownership.
  // A retained player stays mounted while scrolling, but is immediately muted.
  const keepMotion = !constrained && (retainPlayer || videoPreload);
  const shouldPlayLive = isLive && !!liveUri && active && playing && !zoomed;
  const keepLiveMotion = isLive && !!liveUri && (active || keepMotion);

  const updateZoomed = useCallback((z) => {
    if (zoomedRef.current !== z) {
      zoomedRef.current = z;
      setZoomed(z);
    }
  }, []);

  const resetZoom = useCallback(() => {
    clearTimeout(longPressRef.current);
    Animated.parallel([
      settleMotion(zoomScale, 1, { reduced: reduceMotion, scale: true }),
      settleMotion(zoomPanX, 0, { reduced: reduceMotion }),
      settleMotion(zoomPanY, 0, { reduced: reduceMotion }),
    ]).start();
    zoomStateRef.current.scale = 1;
    zoomStateRef.current.panX = 0;
    zoomStateRef.current.panY = 0;
    updateZoomed(false);
  }, [zoomScale, zoomPanX, zoomPanY, updateZoomed, reduceMotion]);

  const zoomTapRef = useRef(0);
  const handleZoomDoubleTap = useCallback(() => {
    const now = Date.now();
    if (now - zoomTapRef.current <= 280) {
      zoomTapRef.current = 0;
      resetZoom();
      return;
    }
    zoomTapRef.current = now;
  }, [resetZoom]);

  const advancedRef = useRef(false);
  useEffect(() => {
    advancedRef.current = false;
  }, [item?.id]);

  const advanceFrame = useCallback(() => {
    if (advancedRef.current) return;
    advancedRef.current = true;
    if (groupCount > 1) onGroupNext?.();
    else onAdvance?.();
  }, [groupCount, onGroupNext, onAdvance]);

  // Prefetch burst-stack frames so transitions never show blank/black frames.
  // The window is bounded (current frame ±2) instead of the whole deck: a
  // 20-frame deck used to prefetch 20 full-resolution files at mount, feeding
  // the decode/IO storm on huge libraries. The remaining frames trickle in on
  // a low-priority timer so flipping deep into a long deck still finds frames
  // cached (PRD §9: neighbouring preload may degrade, blank frames may not).
  useEffect(() => {
    if (supportsNativePhotoPreview || !active || !isBurst || !items || !items.length) return;
    const center = Math.min(Math.max(0, groupIndex || 0), items.length - 1);
    const windowStart = Math.max(0, center - BURST_PREFETCH_RADIUS);
    const windowEnd = Math.min(items.length, center + BURST_PREFETCH_RADIUS + 1);
    const prefetchAt = (idx) => {
      const sib = items[idx];
      if (!sib) return;
      const u = imageUri(sib.displayUri) || imageUri(sib.imageUri);
      if (u) {
        try {
          ExpoImage.prefetch(u);
        } catch {}
      }
    };
    for (let i = windowStart; i < windowEnd; i++) prefetchAt(i);

  }, [active, isBurst, items, groupIndex]);

  // Quiet reveal when a card FIRST enters the preload window, never on
  // activation (avoids a second pop after the previous card leaves).
  const wasPreloadedRef = useRef(false);
  useEffect(() => {
    if (isBurst) return;
    if (preload && !wasPreloadedRef.current) {
      wasPreloadedRef.current = true;
      pop.setValue(reduceMotion ? 1 : MOTION.burstScale);
      settleMotion(pop, 1, { reduced: reduceMotion, scale: true }).start();
    }
    if (!preload && !active) {
      wasPreloadedRef.current = false;
    }
  }, [preload, active, pop, isBurst, item?.id, reduceMotion]);

  // Liquid-glass backdrop breathing: slow zoom so the photo-derived backdrop
  // feels alive. Only run for cards that actually show a backdrop.
  const gesture = useRef({
    movedRef: false,
    position: 0,
    origin: 0,
    latest: 0,
    releaseVelocity: 0,
    dragging: false,
    ready: false,
    version: 0,
  }).current;
  const trashingRef = useRef(false);
  const trashOpVersionRef = useRef(0);
  // Favorite identity guard (ISSUE-004): a slow PhotoKit toggle resolving
  // after the card switched frames (or a second swipe landing meanwhile)
  // must not paint the stale favorite state onto the new frame. Each commit
  // snapshots the item id and bumps a version; a .then from an older or
  // different-frame operation is discarded.
  const favOpVersionRef = useRef(0);
  const latestItemRef = useRef(item);
  latestItemRef.current = item;
  // v142: suppress crossfade when THIS card is being trashed — prevents
  // the fadingPhoto layer from flashing the trashed image on the next card.
  const dismissingRef = useRef(false);

  const clearFade = useCallback(() => {}, []);

  const handleTap = useCallback(() => {
    setPlaying((p) => !p);
  }, []);

  // ---- Favorite (swipe right) stays on the current memory ----
  const setHorizontalGesture = useCallback(
    (next) => {
      if (horizontalGestureRef.current === next) return;
      horizontalGestureRef.current = next;
      onHorizontalGestureChange?.(next);
    },
    [onHorizontalGestureChange]
  );

  const commitFav = useCallback(() => {
    if (trashingRef.current) return;
    trashingRef.current = true;
    // Reset only when the async toggle settles (not after visual snapback):
    // on slow PhotoKit assets the old timing re-opened the gate while the
    // first toggle was still in flight, letting a second swipe flip the
    // favorite twice back to its original value.
    const opVersion = ++favOpVersionRef.current;
    const committedItemId = item?.id;
    const settle = () => {
      if (favOpVersionRef.current !== opVersion) return;
      trashingRef.current = false;
    };
    const isStale = () =>
      favOpVersionRef.current !== opVersion || latestItemRef.current?.id !== committedItemId;
    settleMotion(translateX, 0, { velocity: gesture.releaseVelocity, reduced: reduceMotion }).start();
    toggleFavorite(item)
      .then(({ favorite, changed }) => {
        if (isStale()) {
          settle();
          return;
        }
        setFav(favorite);
        if (!changed) {
          settle();
          return;
        }
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        if (favorite) {
          favBurst.setValue(1);
          fadeMotion(favBurst, 0, reduceMotion ? MOTION.reducedMs : MOTION.feedbackMs).start();
        }
        onFavoriteChange?.(favorite);
        settle();
      })
      .catch(() => {
        settle();
      });
  }, [item, translateX, favBurst, onFavoriteChange, gesture, reduceMotion]);

  // ---- Trash (swipe left): cut audio the moment the card leaves ----
  const assetIdentityRef = useRef(item?.id);
  assetIdentityRef.current = item?.id;
  const commitTrash = useCallback(async () => {
    if (trashingRef.current || !activeRef.current) return;
    trashingRef.current = true;
    const operationId = item?.id;
    const opVersion = ++trashOpVersionRef.current;
    const releasePosition = gesture.position;
    const releaseVelocity = gesture.releaseVelocity;
    silenceAllPlayers();
    setPlaying(false);
    let allowed = false;
    try { allowed = onPrepareTrash ? await onPrepareTrash(item) : false; } catch {}
    if (trashOpVersionRef.current !== opVersion || assetIdentityRef.current !== operationId) return;
    if (!allowed) {
      trashingRef.current = false;
      dismissingRef.current = false;
      settleMotion(translateX, 0, { velocity: releaseVelocity, reduced: reduceMotion }).start(({ finished }) => {
        if (finished && trashOpVersionRef.current === opVersion) setHorizontalGesture(false);
      });
      return;
    }
    dismissingRef.current = true; // v142: suppress crossfade on trash
    gestureMuteRef.current = false;
    // 0ms mute BEFORE anything else (PRD 5.2): never wait for the React
    // commit of setPlaying(false) — the JS thread may be busy for frames.
    silenceAllPlayers();
    setPlaying(false);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    exitMotion(translateX, releasePosition, Math.min(-winWidth, releasePosition), releaseVelocity, reduceMotion).start(({ finished }) => {
      if (!finished || trashOpVersionRef.current !== opVersion || assetIdentityRef.current !== operationId) return;
      if (isBurst) burstDirectionRef.current = 1;
      onTrash?.(item);
      translateX.setValue(0);
      trashingRef.current = false;
      dismissingRef.current = false;
      setHorizontalGesture(false);
    });
  }, [item, translateX, winWidth, onTrash, onPrepareTrash, isBurst, setHorizontalGesture, gesture, reduceMotion]);

  const commitFavRef = useCallback(() => commitFav(), [commitFav]);
  const commitTrashRef = useCallback(() => commitTrash(), [commitTrash]);

  // A recycled burst card and an unmounted card must never accept an old
  // PhotoKit result or an interrupted animation's completion callback.
  useEffect(() => () => {
    favOpVersionRef.current++;
    trashOpVersionRef.current++;
    gesture.version++;
    gesture.dragging = false;
    translateX.stopAnimation();
    translateX.setValue(0);
    favBurst.stopAnimation();
    favBurst.setValue(0);
    trashingRef.current = false;
    dismissingRef.current = false;
    setHorizontalGesture(false);
  }, [item?.id, gesture, translateX, favBurst, setHorizontalGesture]);

  // ---- Long press: video → 2x; live photos and still photos intentionally do nothing ----
  const handleLongPress = useCallback(() => {
    if (!activeRef.current) return;
    if (isVideo) {
      setVideoRate(2);
      return;
    }
  }, [isVideo]);

  const handleLongPressRef = useRef(null);
  handleLongPressRef.current = handleLongPress;

  // Fresh references for the PanResponder.
  const handlerRef = useRef({});
  handlerRef.current = {
    translateX,
    gesture,
    commitTrash: commitTrashRef,
    commitFav: commitFavRef,
    clearFade,
    updateZoomed,
    resetZoom,
    handleZoomDoubleTap,
    setHorizontalGesture,
    resumeGestureAudio,
    reduceMotion,
  };

  const lockDirection = useCallback((g) => {
    const current = gestureDirectionRef.current;
    if (current !== 'undecided' && current !== 'idle') return current;
    const dx = Math.abs(g.dx);
    const dy = Math.abs(g.dy);
    if (Math.max(dx, dy) < DIRECTION_LOCK_DISTANCE) return 'undecided';
    const isLeftSwipe = g.dx < 0;
    const dominance = isLeftSwipe ? 0.95 : HORIZONTAL_DOMINANCE;
    const maxDrift = isLeftSwipe ? 90 : MAX_SWIPE_VERTICAL_DRIFT;
    const horizontal = dx >= dy * dominance && dy <= maxDrift;
    gestureDirectionRef.current = horizontal ? 'horizontal' : 'vertical';
    return gestureDirectionRef.current;
  }, []);

  const shouldCaptureHorizontal = useCallback(
    (e, g) => {
      if (trashingRef.current) return false;
      const touches = e?.nativeEvent?.touches ? e.nativeEvent.touches.length : g.numberActiveTouches;
      if (touches >= 2) return true;
      if (zoomedRef.current) return Math.abs(g.dx) + Math.abs(g.dy) > 8;
      if (!allowFeedGestures) return false;
      return lockDirection(g) === 'horizontal' && Math.abs(g.dx) >= HORIZONTAL_ACTIVATE;
    },
    [allowFeedGestures, lockDirection]
  );

  useEffect(
    () => () => setHorizontalGesture(false),
    [setHorizontalGesture]
  );

  // ---- Swipe / pinch / pan responder (deletes, favorite, zoom) ----
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponderCapture: (e, g) => {
          if (trashingRef.current) return false;
          const touches = e?.nativeEvent?.touches ? e.nativeEvent.touches.length : g.numberActiveTouches;
          return touches >= 2;
        },
        onStartShouldSetPanResponder: (e, g) => {
          if (trashingRef.current) return false;
          const touches = e?.nativeEvent?.touches ? e.nativeEvent.touches.length : g.numberActiveTouches;
          return touches >= 2 || zoomedRef.current;
        },
        onMoveShouldSetPanResponderCapture: shouldCaptureHorizontal,
        onMoveShouldSetPanResponder: shouldCaptureHorizontal,
        onPanResponderTerminationRequest: () =>
          zoomStateRef.current.mode !== 'swipe' && zoomStateRef.current.mode !== 'pinch',

        onPanResponderGrant: (e, g) => {
          const h = handlerRef.current;
          const z = zoomStateRef.current;
          const touches = e?.nativeEvent?.touches ? e.nativeEvent.touches.length : g.numberActiveTouches;
          const isPinch = touches >= 2;
          const isPan = !isPinch && zoomedRef.current;
          z.mode = isPinch ? 'pinch' : isPan ? 'pan' : 'swipe';
          // PRD 5.2: 0ms mute at gesture start — BEFORE the direction is even
          // decided. This is the only leave-path that had no silence entry:
          // during a captured drag (left-swipe delete) audio used to keep
          // playing until the release commit raced the JS thread.
          silenceAllPlayers();
          gestureMuteRef.current = true;
          if (z.mode === 'pinch') {
            z.baseDist = pinchDist(e) || 1;
            z.baseScale = z.scale;
            z.dayBrowseTriggered = false;
            // Freeze vertical scrolling on outer FlatList instantly to prevent vertical displacement
            h.setHorizontalGesture(true);
          } else if (z.mode === 'pan') {
            z.basePanX = z.panX;
            z.basePanY = z.panY;
            h.setHorizontalGesture(true);
          } else {
            beginMotionDrag(h.translateX, h.gesture, g.dx);
            h.gesture.releaseVelocity = 0;
            h.clearFade();
            h.gesture.movedRef = false;
            h.setHorizontalGesture(true);
          }
        },

        onPanResponderMove: (e, g) => {
          const h = handlerRef.current;
          const z = zoomStateRef.current;
          const touches = e?.nativeEvent?.touches ? e.nativeEvent.touches.length : g.numberActiveTouches;
          if (touches >= 2) {
            if (z.mode !== 'pinch') {
              h.gesture.dragging = false;
              h.gesture.version++;
              settleMotion(h.translateX, 0, { reduced: h.reduceMotion }).start();
              z.mode = 'pinch';
              z.baseDist = pinchDist(e) || 1;
              z.baseScale = z.scale;
              clearTimeout(longPressRef.current);
              h.setHorizontalGesture(true);
            }
          }
          if (z.mode === 'pinch') {
            const d = pinchDist(e);
            if (d > 0) {
              const rawScale = z.baseScale * (d / z.baseDist);
              // Ultra-sensitive & 100% deterministic Pinch-In threshold:
              // Triggers Day Browse when fingers move inward by just 8% (rawScale < 0.92)
              if (rawScale < 0.92 && !z.dayBrowseTriggered) {
                z.dayBrowseTriggered = true;
                silenceAllPlayers();
                onPinchInRef.current?.(item);
                return;
              }
              if (z.canZoom) {
                const s = Math.min(Math.max(rawScale, 1), MAX_ZOOM);
                z.scale = s;
                zoomScale.setValue(s);
                h.updateZoomed(s > 1.02);
              }
            }
          } else if (z.mode === 'pan') {
            if (Math.abs(g.dx) + Math.abs(g.dy) > 10) {
              clearTimeout(longPressRef.current);
              setVideoRate(1);
            }
            const s = z.scale;
            const maxX = (winWidth * (s - 1)) / 2;
            const maxY = (height * (s - 1)) / 2;
            const px = Math.min(Math.max(z.basePanX + g.dx, -maxX), maxX);
            const py = Math.min(Math.max(z.basePanY + g.dy, -maxY), maxY);
            z.panX = px;
            z.panY = py;
            zoomPanX.setValue(px);
            zoomPanY.setValue(py);
          } else if (z.mode === 'swipe') {
            h.gesture.movedRef = true;
            moveMotionDrag(h.translateX, h.gesture, g.dx);
          }
        },

        onPanResponderRelease: (e, g) => {
          const h = handlerRef.current;
          const z = zoomStateRef.current;
          clearTimeout(longPressRef.current);
          setVideoRate(1);
          if (z.mode === 'pinch') {
            if (z.scale <= 1.02) h.resetZoom();
            h.resumeGestureAudio();
          } else if (z.mode === 'pan') {
            if (Math.abs(g.dx) + Math.abs(g.dy) <= 8) h.handleZoomDoubleTap();
            h.resumeGestureAudio();
          } else if (z.mode === 'swipe') {
            if (!h.gesture.ready) {
              // A very quick release can beat the native stop callback. Wait
              // for that position before making the same existing decision.
              const released = { ...g };
              h.gesture.onReady = () => panResponder.panHandlers.onPanResponderRelease(e, released);
              return;
            }
            const { dx, dy, vx } = g;
            h.gesture.dragging = false;
            h.gesture.releaseVelocity = vx;
            const isLeft = dx < 0;
            const isHorizontal = isLeft
              ? Math.abs(dx) >= Math.abs(dy) * 0.82 || Math.abs(dx) >= 40
              : Math.abs(dx) > Math.abs(dy) * HORIZONTAL_DOMINANCE && Math.abs(dy) <= MAX_SWIPE_VERTICAL_DRIFT;
            const isTrashCommit = isHorizontal && (dx < -SWIPE_COMMIT || (dx < -16 && vx < -0.32));
            if (isTrashCommit) {
              h.commitTrash();
            } else if (isHorizontal && (dx > SWIPE_COMMIT || (dx > 20 && vx > 0.4))) {
              h.commitFav();
              // Favorite keeps the card as current content — audio comes back.
              h.resumeGestureAudio();
            } else {
              settleMotion(h.translateX, 0, { velocity: vx, reduced: h.reduceMotion }).start();
              h.resumeGestureAudio();
            }
            if (!isTrashCommit) h.setHorizontalGesture(false);
          }
          z.mode = 'none';
          gestureDirectionRef.current = 'idle';
        },

        onPanResponderTerminate: () => {
          const h = handlerRef.current;
          const z = zoomStateRef.current;
          clearTimeout(longPressRef.current);
          setVideoRate(1);
          h.gesture.dragging = false;
          if (z.mode === 'swipe') {
            settleMotion(h.translateX, 0, { reduced: h.reduceMotion }).start();
            h.setHorizontalGesture(false);
          } else if (z.mode === 'pinch' && z.scale <= 1.02) {
            h.resetZoom();
          }
          // Gesture was interrupted without committing anything — resume.
          h.resumeGestureAudio();
          z.mode = 'none';
          gestureDirectionRef.current = 'idle';
        },
      }),
    [shouldCaptureHorizontal, winWidth, height]
  );

  // Tap / long-press detection via raw touch events (does not fight the FlatList).
  const touchRef = useRef({ x: 0, y: 0, startAt: 0, moved: false, count: 1, longPressed: false });
  const onTouchStart = useCallback((e) => {
    const { pageX, pageY } = e.nativeEvent;
    const count = e.nativeEvent.touches.length;
    touchRef.current = {
      x: pageX,
      y: pageY,
      startAt: Date.now(),
      moved: false,
      count,
      longPressed: false,
    };
    gestureDirectionRef.current = 'undecided';
    gesture.movedRef = false;
    clearTimeout(longPressRef.current);
    if (count === 1) {
      longPressRef.current = setTimeout(() => {
        const t = touchRef.current;
        if (t.moved) return;
        t.longPressed = true;
        handleLongPressRef.current?.();
      }, LONG_PRESS_MS);
    }
  }, []);
  const onTouchMove = useCallback(
    (e) => {
      const { pageX, pageY } = e.nativeEvent;
      const t = touchRef.current;
      if (Math.abs(pageX - t.x) > 10 || Math.abs(pageY - t.y) > 10) {
        t.moved = true;
        clearTimeout(longPressRef.current);
        setVideoRate(1);
      }
    },
    []
  );
  const onTouchEnd = useCallback(
    (e) => {
      const t = touchRef.current;
      if (e.nativeEvent.touches.length > 0) return;
      gestureDirectionRef.current = 'idle';
      if (t.count > 1) return;
      clearTimeout(longPressRef.current);
      const wasLongPress = t.longPressed;
      t.longPressed = false;
      setVideoRate(1);
      if (wasLongPress) return; // a long-press ended; not a tap
      if (zoomedRef.current) return;
      if (t.moved || gesture.movedRef || Date.now() - t.startAt >= 300) return;
      if (groupCount > 1) {
        silenceAllPlayers();
        // Upper half (or left edge): Tap UP / Previous frame (direction = -1)
        // Lower half (or right edge): Tap DOWN / Next frame (direction = 1)
        const isUpper = t.y != null && t.y < (height || 800) * 0.48;
        const isLeft = t.x != null && t.x < winWidth * 0.32;
        const direction = (isUpper || isLeft) ? -1 : 1;
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        burstDirectionRef.current = direction;
        onGroupNext?.(direction);
      } else if (isVideo) {
        handleTap();
      }
      // single photos / live photos: tap intentionally does nothing
    },
    [handleTap, onGroupNext, groupCount, isVideo, winWidth, height]
  );

  // Auto-resume a fresh item (also when advancing within a burst group).
  useEffect(() => {
    silenceAllPlayers();
    if (active) setPlaying(true);
  }, [active, item?.id, groupIndex]);

  // Reset video UI state when the memory (or burst frame) changes.
  useEffect(() => {
    setVideoFirstFrame(false);
    setVideoThumb(null);
  }, [item?.id]);

  useEffect(() => {
    let cancelled = false;
    if (isVideo) {
      setAmbientPhotoUri(null);
      return undefined;
    }
    const directFile = [item.imageUri, item.localUri, item.displayUri, fallbackUri]
      .find((u) => typeof u === 'string' && u.startsWith('file://'));
    if (directFile) {
      setAmbientPhotoUri(directFile);
      return undefined;
    }
    if (supportsNativePhotoPreview) return undefined;
    getDisplayUri(item).then((uri) => {
      if (!cancelled && uri && uri.startsWith('file://')) {
        setAmbientPhotoUri(uri);
      }
    }).catch(() => {
      if (!cancelled) setAmbientPhotoUri(null);
    });
    return () => {
      cancelled = true;
    };
  }, [isVideo, item?.id, fallbackUri]);

  // Resolve the first frame once and keep it as the backdrop for the lifetime
  // of this deck, even when that frame is removed from the visible items.
  useEffect(() => {
    let cancelled = false;
    if (!isBurst || !item) return;
    if (!burstBackdropAnchorRef.current) burstBackdropAnchorRef.current = items?.[0] || item;
    if (supportsNativePhotoPreview) return;
    const anchor = burstBackdropAnchorRef.current;
    const directFile = [anchor.imageUri, anchor.localUri, anchor.displayUri]
      .find((u) => typeof u === 'string' && u.startsWith('file://'));
    if (directFile) {
      setBurstBackdropUri((current) => current || directFile);
      return;
    }
    getUriFallback(anchor).then((uri) => {
      if (!cancelled && uri && uri.startsWith('file://')) {
        setBurstBackdropUri((current) => current || uri);
      }
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isBurst, items]);

  // First-frame thumbnail for video cards — independent of the player, so a
  // video card ALWAYS has a visible base image and ambient background color.
  useEffect(() => {
    let cancelled = false;
    if (!isVideo) {
      setVideoThumb(null);
      return undefined;
    }

    async function resolveThumb() {
      if (supportsNativePhotoPreview) return;
      // v129: prefer the permission-bearing readable URI from getUriFallback
      // (requestAVAsset's AVURLAsset.url — a readable file://). ph:// is only
      // playable by expo-video; VideoThumbnails needs a real readable file.
      // Fall back to ph:// (displayUri), then localUri with the PhotoKit
      // bookmark fragment (#...) stripped, then imageUri. Cache by displayUri.
      const candidates = [];
      if (typeof fallbackUri === 'string' && fallbackUri.startsWith('file://')) candidates.push(fallbackUri);
      if (typeof item?.displayUri === 'string') candidates.push(item.displayUri);
      if (typeof item?.localUri === 'string') {
        const clean = item.localUri.split('#')[0];
        if (clean !== item.localUri) candidates.push(clean);
      }
      if (typeof item?.imageUri === 'string') candidates.push(item.imageUri);
      if (!candidates.length) {
        try {
          const resolved = await getDisplayUri(item);
          if (resolved) candidates.push(resolved);
        } catch {}
      }
      if (!candidates.length || cancelled) return;

      const cacheKey = item.displayUri || candidates[0];
      const cached = videoThumbCache.get(cacheKey);
      if (cached) {
        setVideoThumb(cached);
        return;
      }

      for (const src of candidates) {
        if (!src || cancelled) return;
        try {
          const { uri } = await VideoThumbnails.getThumbnailAsync(src, VIDEO_THUMB_OPTIONS);
          if (!cancelled && uri) {
            videoThumbCache.set(cacheKey, uri);
            setVideoThumb(uri);
            return;
          }
        } catch {}
      }
      // t=0 can be a black keyframe; retry at a later frame before giving up.
      for (const src of candidates) {
        if (!src || cancelled) return;
        try {
          const { uri } = await VideoThumbnails.getThumbnailAsync(src, { ...VIDEO_THUMB_OPTIONS, time: 400 });
          if (!cancelled && uri) {
            videoThumbCache.set(cacheKey, uri);
            setVideoThumb(uri);
            return;
          }
        } catch {}
      }
      // v130 last resort: copy the video into the app sandbox via the native
      // PHAssetResourceManager channel (expo-file-system copyAsync supports
      // ph:// sources) — the resulting file:// is readable by VideoThumbnails
      // on iOS 18+. Cached per asset, so this happens at most once per video.
      if (!cancelled) {
        try {
          const sandboxed = await getSandboxMediaUri(item);
          if (sandboxed && sandboxed.startsWith('file://')) {
            try {
              const { uri } = await VideoThumbnails.getThumbnailAsync(sandboxed, VIDEO_THUMB_OPTIONS);
              if (!cancelled && uri) {
                videoThumbCache.set(cacheKey, uri);
                setVideoThumb(uri);
                return;
              }
            } catch {
              const { uri } = await VideoThumbnails.getThumbnailAsync(sandboxed, { ...VIDEO_THUMB_OPTIONS, time: 400 });
              if (!cancelled && uri) {
                videoThumbCache.set(cacheKey, uri);
                setVideoThumb(uri);
              }
            }
          }
        } catch {}
      }
    }

    resolveThumb();
    return () => {
      cancelled = true;
    };
  }, [isVideo, item, fallbackUri]);

  // Diagnostics: log the content type of every card that becomes active, so
  // device logs show live photos / photos / bursts as well as videos.
  // DEV-only — release builds must not pay the string/IO cost per card.
  useEffect(() => {
    if (!__DEV__ || !active || !item?.id) return;
    const type = isBurst ? `burst(${items?.length || 0})` : isVideo ? 'video' : item.isLive ? 'live' : 'photo';
    console.log('[card] active:', type, item.filename || item.id);
  }, [active, item?.id]);

  // Diagnostics: report the resolved video source. ph:// PhotoKit URIs are
  // played by expo-video through PhotoKit (no direct file access); a file:// is
  // stat-ed to confirm it exists on disk.
  useEffect(() => {
    if (!__DEV__ || !isVideo || !active || !item?.displayUri) return;
    const uri = item.displayUri;
    if (uri.startsWith('ph://') || uri.startsWith('assets-library://')) {
      console.log('[video] source (PhotoKit):', uri);
      return;
    }
    FileSystem.getInfoAsync(uri)
      .then((info) => console.log('[video] source:', uri, 'exists=' + info.exists, 'size=' + (info.size ?? '?')))
      .catch((e) => console.log('[video] source stat failed:', uri, e?.message));
  }, [isVideo, active, item?.displayUri]);

  // Reset zoom when the card stops being active or the item changes.
  useEffect(() => {
    if (!active) resetZoom();
  }, [active, item?.id, resetZoom]);

  // Notify parent so it can lock the list scroll while zoomed.
  useEffect(() => {
    onZoomStateChange?.(zoomed);
  }, [zoomed, onZoomStateChange]);

  useEffect(() => () => clearTimeout(longPressRef.current), []);

  useEffect(() => {
    setInfoExpanded(false);
    setInfoExif(null);
    setInfoSize(null);
    setPlace(item.placeName || '');
    setPlaceShort(item.placeShortName || '');
  }, [item.id]);

  // Keep favorite + place in sync when the item becomes active or preloaded.
  useEffect(() => {
    if (!active && !preload) return;
    setFav(isItemFavorite(item));
    let cancelled = false;
    (async () => {
      await loadItemBasics(item);
      if (cancelled) return;
      setFav(isItemFavorite(item));
      const name = await getPlaceName(item);
      if (!cancelled) {
        // Place labels are never populated since geocoding was removed; raw
        // GPS coordinates keep the location row alive with zero telemetry.
        const display = name || formatGpsCoordinate(item.location);
        setPlace(display);
        setPlaceShort(display);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, preload, item]);

  useEffect(() => {
    if (!active || !infoExpanded) return;
    let cancelled = false;
    Promise.all([loadExif(item), getAssetSizeBytes(item)]).then(([exif, size]) => {
      if (cancelled) return;
      setInfoExif(exif || {});
      setInfoSize(size > 0 ? size : 0);
    });
    return () => {
      cancelled = true;
    };
  }, [active, infoExpanded, item]);

  // Load live-photo video for the current item.
  useEffect(() => {
    if (!item.isLive || (!active && !retainPlayer && !videoPreload)) {
      setLiveUri(null);
      return;
    }
    setLiveUri(item.livePhotoUri || null);
    if (!active && !item.livePhotoUri) return;
    let cancelled = false;
    (async () => {
      const uri = await loadLivePhotoUri(item);
      if (!cancelled && uri) setLiveUri(uri);
    })();
    return () => {
      cancelled = true;
    };
  }, [item, active, retainPlayer, videoPreload]);

  // Still photos are kept purely static per user request (no Ken Burns drift).

  // ---- Still-frame fallback chain (photos & live photos) ----
  useEffect(() => {
    setStillStep(0);
    if (!isBurst) {
      setRenderedStep(-1);
      setFallbackUri(null);
    }
    if (!item || supportsNativePhotoPreview) return;
    let cancelled = false;
    (async () => {
      const u = await getUriFallback(item);
      if (cancelled) return;
      if (u) setFallbackUri(u);
      else setStillStep((s) => (s === 2 ? 3 : s));
    })();
    return () => {
      cancelled = true;
    };
  }, [item, item?.displayUri, item?.imageUri, item?.localUri, item?.previewUri, isBurst]);

  useEffect(() => {
    // Watchdog: rescue a still that never fired load OR error on the FIRST
    // renderer only; afterwards the onError chain owns the fallback flow.
    if (supportsNativePhotoPreview || isVideo || stillStep !== 0 || renderedStep >= 0) return;
    const t = setTimeout(() => setStillStep(1), 3500);
    return () => clearTimeout(t);
  }, [isVideo, stillStep, renderedStep, item]);

  useEffect(() => {
    // Tier 1 is a dead end — it re-renders the SAME source under the SAME
    // key, so the image never retries. If the photo still hasn't rendered,
    // escalate to the sandbox fallback (or the failure text when no
    // fallback exists) instead of leaving burst chrome over an empty canvas.
    if (supportsNativePhotoPreview || isVideo || stillStep !== 1 || renderedStep >= 0) return;
    const t = setTimeout(() => setStillStep(fallbackUri ? 2 : 3), 3000);
    return () => clearTimeout(t);
  }, [isVideo, stillStep, renderedStep, item, fallbackUri]);

  // Grace period before showing loading spinner: fast prefetched images (10-50ms)
  // NEVER flash a spinner, matching TikTok / Douyin instant browsing.
  useEffect(() => {
    setShowLoadingSpinner(false);
    if (!active) return undefined;
    const t = setTimeout(() => {
      setShowLoadingSpinner(true);
    }, 350);
    return () => clearTimeout(t);
  }, [active, item?.id]);

  // ---- Gesture-driven interpolations ----
  const rotate = translateX.interpolate({
    inputRange: [-200, 0, 200],
    outputRange: reduceMotion ? ['0deg', '0deg', '0deg'] : [`-${MOTION.swipeTilt}deg`, '0deg', `${MOTION.swipeTilt}deg`],
    extrapolate: 'clamp',
  });
  // Directional tint reveals what each swipe commits to (right = favorite, left = trash).
  const favBgOpacity = translateX.interpolate({
    inputRange: [0, SWIPE_COMMIT],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });
  const trashBgOpacity = translateX.interpolate({
    inputRange: [-SWIPE_COMMIT, 0],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });
  const heartOpacity = translateX.interpolate({
    inputRange: [0, SWIPE_COMMIT],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });
  const heartScale = translateX.interpolate({
    inputRange: [0, 160],
    outputRange: reduceMotion ? [1, 1] : [0.85, 1],
    extrapolate: 'clamp',
  });
  const trashOpacity = translateX.interpolate({
    inputRange: [-SWIPE_COMMIT, 0],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });
  const trashScale = translateX.interpolate({
    inputRange: [-160, 0],
    outputRange: reduceMotion ? [1, 1] : [1, 0.85],
    extrapolate: 'clamp',
  });
  const favBurstScale = favBurst.interpolate({
    inputRange: [0, 1],
    outputRange: reduceMotion ? [1, 1] : [1, MOTION.pulseScale],
  });

  // Photos decode for every rendered card (swipe must never wait for a fresh
  // decode); only the blur letterbox is gated to the active card to cut memory.
  // Keep one active player plus one muted, viewless next-card preloader. More
  // players starve iOS decoders and were the root cause of black-screen reports.
  const showVideo = isVideo && (active || keepMotion);
  const showLiveMotion = keepLiveMotion;

  // Card geometry: media-proportional contain fit — the card is as large as
  // possible inside the screen margins and hugs the photo/video aspect ratio
  // (no letterbox inside the card, no crop).
  const maxCardW = maxWidth || (winWidth - 12);
  
  const { width: cardW, height: cardH } = photoCardSize(item, maxCardW, height);
  const cardTop = Math.round((height - cardH) / 2);
  const stillFit = 'cover';

  // Never send a PhotoKit ph:// URI to ExpoImage on iOS. Photos must use the
  // sandbox/readable file resolved above; videos keep their PhotoKit source.
  const readableSource = imageUri(fallbackUri);
  const stillSource = isVideo
    ? (item.uri || item.displayUri || item.localUri || videoThumb)
    : (imageUri(item.imageUri)
      || imageUri(item.displayUri)
      || imageUri(item.localUri)
      || readableSource
      || imageUri(ambientPhotoUri));
  const stillFallbackSource = readableSource || imageUri(item.localUri);
  const videoThumbSource = imageUri(videoThumb);
  const ambientSource = isBurst
    ? (imageUri(burstBackdropUri) || imageUri(ambientPhotoUri) || imageUri(stillSource))
    : (isVideo
      ? videoThumbSource
      : (imageUri(ambientPhotoUri) || imageUri(stillSource) || readableSource));

  const showPhotoSurface = !isVideo && (active || preload) && (supportsNativePhotoPreview || Boolean(stillSource));
  const cameraName = [exifValue(infoExif, 'Make'), exifValue(infoExif, 'Model')]
    .filter((value, index, values) => value && values.indexOf(value) === index)
    .join(' ');
  const lensName = exifValue(infoExif, 'LensModel', 'LensInfo');
  const aperture = exifValue(infoExif, 'FNumber', 'ApertureValue');
  const exposure = exifValue(infoExif, 'ExposureTime', 'ShutterSpeedValue');
  const iso = exifValue(infoExif, 'ISOSpeedRatings', 'PhotographicSensitivity', 'ISO');
  const dimensions = item?.width && item?.height ? `${item.width} × ${item.height}` : '';

  return (
    <View
      style={[styles.cell, { height }]}
      {...panResponder.panHandlers}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      <View style={styles.mediaArea}>
        {showAmbient ? (
          <AmbientBackdrop
            source={active || preload ? (ambientSource || (supportsNativePhotoPreview ? `ph://${isBurst ? (burstBackdropAnchorRef.current?.id || items?.[0]?.id || item.id) : item.id}` : null)) : null}
          />
        ) : null}

        {/* Directional swipe feedback: 
            Right swipe = Pure White Glass Glow on LEFT edge + White Heart Burst in center
            Left swipe  = Crimson Red Collector Aura Bloom on RIGHT edge + MaoQiu Collector Badge */}
        <View style={styles.swipeBg} pointerEvents="none">
          <Animated.View style={[styles.swipeBgLayer, { opacity: favBgOpacity }]}>
            <LinearGradient
              colors={['rgba(255,255,255,0.82)', 'rgba(255,255,255,0.35)', 'rgba(255,255,255,0.05)', 'transparent']}
              start={{ x: 0, y: 0.5 }}
              end={{ x: 0.72, y: 0.5 }}
              style={StyleSheet.absoluteFill}
            />
          </Animated.View>
          <Animated.View style={[styles.swipeBgLayer, { opacity: trashBgOpacity }]}>
            <LinearGradient
              colors={['transparent', 'rgba(0,0,0,0.20)', 'rgba(225,29,72,0.12)', 'rgba(225,29,72,0.35)']}
              start={{ x: 0.25, y: 0.5 }}
              end={{ x: 1, y: 0.5 }}
              style={StyleSheet.absoluteFill}
            />
          </Animated.View>
        </View>

        {/* Stacked burst deck: remaining frames fan out UNDER the front card,
            same size, each pushed down + rotated so the edges clearly show. */}
        {isBurst && items && items.length > 1 && burstChromeReady ? (
          <Animated.View
            style={[
              styles.stackLayer,
              {
                left: Math.round((winWidth - cardW) / 2),
                width: cardW,
                bottom: cardTop,
                height: cardH,
                opacity: burstDeckReveal,
              },
            ]}
            pointerEvents="none"
          >
            {Array.from({ length: Math.min(items.length - 1, 3) }, (_, i) => {
              const k = i + 1;
              const sib = items[(groupIndex + k) % items.length];
              const stackUri = imageUri(sib.displayUri) || imageUri(sib.imageUri) || imageUri(sib.localUri);
              const stackColor = BURST_RAINBOW_BORDER_COLORS[(sib.burstIndex ?? (groupIndex + k)) % BURST_RAINBOW_BORDER_COLORS.length];
              return (
                <Animated.View
                  key={`stack-${sib.id}`}
                  style={[
                    styles.stackCard,
                    {
                      zIndex: 4 - k,
                      transform: burstPoses[k],
                      borderWidth: 2,
                      borderColor: stackColor,
                    },
                  ]}
                >
                  {supportsNativePhotoPreview && (active || preload) ? (
                    <PhotoKitPreview assetId={sib.id} style={styles.stackCardImg} resizeMode="cover" maxPixelSize={512} priority={1} purpose="burst" />
                  ) : stackUri ? (
                    <ExpoImage
                      source={{ uri: stackUri }}
                      recyclingKey={stackUri}
                      style={styles.stackCardImg}
                      contentFit="cover"
                      transition={0}
                    />
                  ) : null}
                </Animated.View>
              );
            })}
          </Animated.View>
        ) : null}

        {/* Card animation layer — ONLY the card moves on swipe / trash / favorite */}
        <Animated.View
          style={[
            styles.slide,
            {
              transform: [
                { rotate },
                { translateX },
                ...burstPoses[0],
              ],
            },
          ]}
        >
          <Animated.View
            style={[
              styles.card,
              {
                width: cardW,
                height: cardH,
                backgroundColor: 'transparent',
                transform: [{ scale: zoomScale }, { translateX: zoomPanX }, { translateY: zoomPanY }],
                ...(burstBorderColor && burstChromeReady ? { borderWidth: 2, borderColor: burstBorderColor } : null),
              },
            ]}
          >
            {/* Clipped media container — images only. AVPlayerLayer MUST NOT be
                inside overflow:hidden + borderRadius (masksToBounds forces
                offscreen rendering → black video), so video lives in its own
                unmasked layer below. */}
            <View style={styles.cardInner} pointerEvents="box-none">
              <View style={styles.mediaInner} pointerEvents="box-none">
                {/* Off-screen / inactive cards show a quiet placeholder instead of decoding media */}
                {!showPhotoSurface && !showVideo ? (
                  <View style={styles.mediaPlaceholder} pointerEvents="none">
                    <Ionicons name="image-outline" size={42} color="rgba(255,255,255,0.16)" />
                  </View>
                ) : null}

            <Animated.View style={[styles.popLayer, { transform: [{ scale: pop }] }]}>
              <Animated.View style={styles.zoomLayer}>
              {/* Photos & live photos: clean static display without jitter */}
              {showPhotoSurface ? (
                <View style={styles.kbLayer}>
                  {supportsNativePhotoPreview ? (
                    <PhotoKitPreview
                      key={`native-${item.id}`}
                      assetId={item.id}
                      priority={active ? 0 : 1}
                      purpose={purpose}
                      style={styles.still}
                      resizeMode={stillFit === 'cover' ? 'cover' : 'contain'}
                      resolutionScale={zoomed ? 4 : 1}
                      onLoad={() => { setStillStep(0); setRenderedStep(0); setDisplayedMediaId(item.id); }}
                      onError={() => { setDisplayedMediaId(null); setStillStep(3); reportMediaDisplayFailure(item); }}
                    />
                  ) : stillSource && stillStep < 2 ? (
                    <ExpoImage
                      key={isBurst ? 'burst-photo-canvas' : `still-${item.id}-e0`}
                      source={{ uri: stillSource }}
                      recyclingKey={stillSource}
                      cachePolicy="memory-disk"
                      style={styles.still}
                      contentFit={stillFit}
                      transition={isBurst ? 0 : 200}
                      onLoad={() => { setStillStep(0); setRenderedStep(0); setDisplayedMediaId(item.id); }}
                      onError={() => { setDisplayedMediaId(null); setStillStep(2); }}
                    />
                  ) : null}
                  {!supportsNativePhotoPreview && stillStep === 2 && stillFallbackSource ? (
                    <ExpoImage
                      key={isBurst ? 'burst-photo-fb' : `still-${item.id}-e2`}
                      source={{ uri: stillFallbackSource }}
                      recyclingKey={stillFallbackSource}
                      style={styles.still}
                      contentFit={stillFit}
                      transition={isBurst ? 0 : 200}
                      onLoad={() => { setRenderedStep(2); setDisplayedMediaId(item.id); }}
                      onError={() => { setDisplayedMediaId(null); setStillStep(3); reportMediaDisplayFailure(item); }}
                    />
                  ) : null}
                  {stillStep === 3 ? (
                    <View style={styles.mediaFailed}>
                      <Ionicons name="image-outline" size={30} color={colors.textMuted} />
                      <Text style={styles.mediaFailedText}>{t('home.imageLoadFailed')}</Text>
                    </View>
                  ) : null}
                </View>
              ) : null}
              </Animated.View>
            </Animated.View>
            </View>
            </View>

            {/* Video: unmasked layer with self-rounded corners. Base layer is
                the first-frame thumbnail (contain), so the card is NEVER a
                black rectangle — the player mounts on top when active. */}
            {isVideo ? (
              <View style={styles.videoLayer} pointerEvents="box-none">
                {supportsNativePhotoPreview && (active || preload) ? (
                  <PhotoKitPreview priority={active ? 0 : 1} purpose={purpose} assetId={item.id} style={[styles.coverFill, styles.videoCorner]} resizeMode="contain" />
                ) : videoThumbSource ? (
                  <ExpoImage
                    source={{ uri: videoThumbSource }}
                    recyclingKey={videoThumbSource}
                    cachePolicy="memory-disk"
                    style={[styles.coverFill, styles.videoCorner]}
                    contentFit="contain"
                    transition={200}
                    pointerEvents="none"
                  />
                ) : null}
                {showVideo && item.displayUri ? (
                  <MemoryVideo
                    key={`video-${item.id}`}
                    uri={item.displayUri}
                    playing={active && playing}
                    loop
                    rate={videoRate}
                    onEnd={advanceFrame}
                    onFirstFrame={() => { setVideoFirstFrame(true); setDisplayedMediaId(item.id); }}
                    showProgress={false}
                    controlsActive={active}
                    onPlayerChange={handleVideoPlayerChange}
                    showView={active}
                    style={[styles.coverFill, styles.videoCorner]}
                  />
                ) : null}

                {active && !item.displayUri ? (
                  <View style={styles.mediaFailed} pointerEvents="none">
                    <Ionicons name="videocam-off-outline" size={30} color={colors.textMuted} />
                    <Text style={styles.mediaFailedText}>{t('home.videoLoadFailed')}</Text>
                  </View>
                ) : null}
              </View>
            ) : null}

            {/* Live photo motion: same unmasked treatment (contain video) */}
            {isLive && liveUri && showLiveMotion ? (
              <View style={styles.videoLayer} pointerEvents="none">
                <LivePhotoVideo
                  key={`live-${item.id}`}
                  uri={liveUri}
                  playing={shouldPlayLive}
                  loop
                  onPlayerChange={handleLivePlayerChange}
                  style={[styles.coverFill, styles.videoCorner]}
                />
              </View>
            ) : null}

            {/* Center swipe badges (Tinder-style, live inside the card) */}
            <View style={styles.swipeBadge} pointerEvents="none">
              <Animated.View style={[styles.heartBadge, { opacity: heartOpacity, transform: [{ scale: heartScale }, { rotate: '-16deg' }] }]}>
                <Ionicons name="heart" size={92} color={colors.fav} />
              </Animated.View>
              <Animated.View style={[styles.trashPortal, { opacity: trashOpacity, transform: [{ scale: trashScale }, { rotate: '-8deg' }] }]}>
                <View style={styles.trashMaoQiuGlow}>
                  <MaoQiuIcon size={78} color="#FF3B30" />
                </View>
                <Text style={styles.trashPortalText} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.7}>{t('home.moveToMaoqiu')}</Text>
              </Animated.View>
            </View>

            {/* Favorite burst (inside the card) */}
            <Animated.View
              style={[styles.favBurst, { opacity: favBurst, transform: [{ scale: favBurstScale }] }]}
              pointerEvents="none"
            >
              <Ionicons name="heart" size={64} color={colors.fav} />
            </Animated.View>

            {/* loading indicator (photo & video) — inside card for exact geometric center alignment */}
            {active && !isBurst && showLoadingSpinner && ((showPhotoSurface && renderedStep === -1) || (isVideo && item.displayUri && !videoFirstFrame)) ? (
              <View style={styles.videoLoadingOverlay} pointerEvents="none">
                <View style={styles.videoLoadingMark}>
                  <ActivityIndicator size="small" color="#fff" />
                </View>
              </View>
            ) : null}

            {/* Pause indicator: centered glass play button (video only) */}
            {!playing && active && !zoomed && !trashingRef.current && !dismissingRef.current ? (
              <View style={styles.pauseOverlay} pointerEvents="none">
                <View style={styles.pauseBtn}>
                  <Ionicons name="play" size={46} color="#fff" style={styles.pauseIcon} />
                </View>
              </View>
            ) : null}

            {/* Top-left media type badge (fixed 14dp offset from content top edge) */}
            {showTypeBadge && (isVideo || isLive) ? (
              <View style={styles.cardTypeBadgeWrap} pointerEvents="none">
                <GlassPanel style={styles.cardTypeBadge} radius={14} intensity={65}>
                  <Ionicons
                    name={isVideo ? "videocam" : "aperture"}
                    size={13}
                    color="#FFFFFF"
                  />
                  <Text style={styles.cardTypeBadgeText}>
                    {isVideo ? (t('home.videoTag') || '视频') : (t('home.liveBadge') || '实况')}
                  </Text>
                </GlassPanel>
              </View>
            ) : null}
          </Animated.View>
        </Animated.View>

      {/* Bottom scrim for readability */}
      <LinearGradient
        colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.32)']}
        style={styles.bottomScrim}
        pointerEvents="none"
      />

      {/* Top-left date and place. The compact state never exposes a full address. */}
      {showInfo ? <View style={[styles.infoWrap, infoExpanded && styles.infoWrapExpanded, { left: 18, top: insets.top + 12 }]}>
        <Pressable onPress={() => setInfoExpanded((expanded) => !expanded)}>
          <GlassPanel style={styles.infoPanel} radius={22} intensity={40}>
            <View style={styles.infoRowTop}>
              {fav ? (
                <View style={styles.favoriteIndicator}>
                  <Ionicons name="heart" size={17} color={colors.fav} />
                </View>
              ) : null}
              <Text style={styles.infoDate} numberOfLines={1}>
                {formatDateShort(item.creationTime) || '回忆'}
              </Text>
              {isLive ? (
                <View style={styles.badge}>
                  <Ionicons name="aperture" size={10} color={colors.textMuted} />
                  <Text style={styles.badgeText}>实况</Text>
                </View>
              ) : null}
              {isVideo ? (
                <View style={styles.badge}>
                  <Ionicons name="play" size={9} color={colors.textMuted} />
                  <Text style={styles.badgeText}>视频</Text>
                </View>
              ) : null}
              {groupCount > 1 ? (
                <View style={[styles.badge, burstBorderColor ? { borderColor: burstBorderColor, borderWidth: StyleSheet.hairlineWidth } : null]}>
                  <Ionicons name="images" size={10} color={burstBorderColor || colors.primarySoft} />
                  <Text style={[styles.badgeText, burstBorderColor ? { color: '#fff' } : null]}>{`连拍 ${groupIndex + 1}/${groupCount}`}</Text>
                </View>
              ) : null}
            </View>
            {placeShort || place ? (
              <Text style={styles.infoPlace} numberOfLines={1}>
                {placeShort || place}
              </Text>
            ) : null}
            {infoExpanded ? (
              <View style={styles.infoDetails}>
                <DetailLine icon="calendar-outline">{formatDateTime(item.creationTime)}</DetailLine>
                {place ? <DetailLine icon="location-outline">{place}</DetailLine> : null}
                {item.filename ? <DetailLine icon="document-outline">{item.filename}</DetailLine> : null}
                {dimensions ? <DetailLine icon="expand-outline">{dimensions}</DetailLine> : null}
                {infoSize === null ? <DetailLine icon="hourglass-outline">读取拍摄信息…</DetailLine> : null}
                {infoSize > 0 ? <DetailLine icon="folder-outline">{formatBytes(infoSize)}</DetailLine> : null}
                {cameraName ? <DetailLine icon="camera-outline">{cameraName}</DetailLine> : null}
                {lensName ? <DetailLine icon="scan-outline">{lensName}</DetailLine> : null}
                {aperture ? <DetailLine icon="aperture-outline">{`ƒ/${aperture}`}</DetailLine> : null}
                {exposure ? <DetailLine icon="timer-outline">{`${exposure}s`}</DetailLine> : null}
                {iso ? <DetailLine icon="sunny-outline">{`ISO ${iso}`}</DetailLine> : null}
              </View>
            ) : null}
          </GlassPanel>
        </Pressable>
      </View> : null}

    </View>
    </View>
  );
}

/**
 * Feed rows are virtualized but NOT memoized by default: every HomeScreen
 * state flip (scrolling, toasts, activeIndex, feed rebuilds) re-ran this
 * 2,000-line component for every mounted row and janked the swipe gesture.
 *
 * The comparator is deliberately asymmetric: the ACTIVE card always
 * re-renders (playback, gestures and per-frame state must never go stale on
 * the visible card), while off-screen rows only re-render when a semantic
 * prop changed. Callback props are ignored on purpose — they are inline
 * closures recreated on every parent render but their behavior only depends
 * on the compared identity props (entry key / item ids).
 */
function memoryCardPropsEqual(prev, next) {
  if (prev.active || next.active) return false;
  const prevItems = prev.items;
  const nextItems = next.items;
  const itemsEqual =
    prevItems === nextItems ||
    (Array.isArray(prevItems) &&
      Array.isArray(nextItems) &&
      prevItems.length === nextItems.length &&
      prevItems[0]?.id === nextItems[0]?.id &&
      prevItems[prevItems.length - 1]?.id === nextItems[nextItems.length - 1]?.id);
  return (
    prev.item?.id === next.item?.id &&
    itemsEqual &&
    prev.height === next.height &&
    prev.maxWidth === next.maxWidth &&
    prev.preload === next.preload &&
    prev.videoPreload === next.videoPreload &&
    prev.retainPlayer === next.retainPlayer &&
    prev.constrained === next.constrained &&
    prev.groupIndex === next.groupIndex &&
    prev.groupCount === next.groupCount &&
    prev.allowFeedGestures === next.allowFeedGestures &&
    prev.showInfo === next.showInfo &&
    prev.showAmbient === next.showAmbient &&
    prev.showTypeBadge === next.showTypeBadge &&
    prev.purpose === next.purpose &&
    prev.onMediaReady === next.onMediaReady
  );
}

export default memo(MemoryCard, memoryCardPropsEqual);

const styles = StyleSheet.create({
  cell: {
    width: '100%',
    backgroundColor: '#0c1424',
  },
  slide: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    position: 'relative',
    borderRadius: 24,
    // MD3 Filled Card: 0dp border — shape defined by shadow only
    // Removing hairlineWidth border eliminates sub-pixel antialiasing "fuzz"
    backgroundColor: 'transparent',
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
  },
  cardInner: {
    flex: 1,
    borderRadius: 23,   // 1px less than outer to not expose the overflow-hidden seam
    overflow: 'hidden', // clip lives here only — away from the border layer
    backgroundColor: 'transparent',
  },
  // The card itself owns clipping for every media type, so video and photo
  // share exactly the same clean rounded silhouette.
  videoLayer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: 23,
    overflow: 'hidden',
  },
  videoCorner: {
    borderRadius: 23,
  },
  videoProgressWrap: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 14,
    gap: 7,
  },
  videoProgressTrack: {
    height: 20,
    justifyContent: 'center',
  },
  videoProgressBase: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 8,
    height: 3,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.30)',
  },
  videoProgressFill: {
    height: 3,
    borderRadius: 2,
    backgroundColor: colors.white,
  },
  videoProgressThumb: {
    position: 'absolute',
    top: 5,
    width: 10,
    height: 10,
    marginLeft: -5,
    borderRadius: 5,
    backgroundColor: colors.white,
  },
  videoProgressTime: {
    alignSelf: 'flex-end',
    color: 'rgba(255,255,255,0.84)',
    fontSize: 10,
    fontVariant: ['tabular-nums'],
  },
  mediaArea: {
    flex: 1,
    backgroundColor: '#000',
  },
  swipeBg: {
    ...StyleSheet.absoluteFillObject,
  },
  swipeBgLayer: {
    ...StyleSheet.absoluteFillObject,
  },
  mediaInner: {
    flex: 1,
  },
  popLayer: {
    flex: 1,
  },
  zoomLayer: {
    flex: 1,
    overflow: 'hidden',
  },
  stackLayer: {
    position: 'absolute',
  },
  stackCard: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    borderRadius: 24,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.20)',
    backgroundColor: 'transparent',
    shadowColor: '#000',
    shadowOpacity: 0.38,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  stackCardImg: {
    flex: 1,
    width: '100%',
    height: '100%',
  },
  kbLayer: {
    flex: 1,
    overflow: 'hidden',
  },
  still: {
    flex: 1,
    width: '100%',
    height: '100%',
  },
  coverFill: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  fadingPhoto: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  mediaLoading: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  videoLoadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: 32, // Optical center alignment considering bottom control pill & top bar
    zIndex: 30,
  },
  videoLoadingMark: {
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(10,14,24,0.68)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.32)',
    shadowColor: '#000',
    shadowOpacity: 0.36,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
  },
  videoPlayIcon: {
    marginLeft: 2, // optical centering for triangle inside circle
  },
  mediaPlaceholder: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mediaFailed: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  mediaFailedText: {
    color: colors.textMuted,
    fontSize: 13,
  },
  bottomScrim: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 200,
  },
  swipeBadge: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heartBadge: {
    position: 'absolute',
    borderRadius: 28,
    borderWidth: 3,
    borderColor: '#FFFFFF',
    backgroundColor: 'rgba(255, 255, 255, 0.20)',
    padding: 10,
    shadowColor: '#FFFFFF',
    shadowOpacity: 0.65,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 0 },
    elevation: 8,
  },
  trashPortal: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
  },
  trashMaoQiuGlow: {
    shadowColor: '#FF3B30',
    shadowOpacity: 0.85,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 6 },
    elevation: 16,
  },
  trashPortalText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#FFFFFF',
    marginTop: 8,
    letterSpacing: 1.0,
    maxWidth: '82%',
    textAlign: 'center',
    textShadowColor: 'rgba(0, 0, 0, 0.75)',
    textShadowRadius: 8,
    textShadowOffset: { width: 0, height: 2 },
  },
  favBurst: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pauseOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: 32, // Optical center alignment matching video loading mark
  },
  pauseBtn: {
    width: 88,
    height: 88,
    borderRadius: 44,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.35)',
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  pauseIcon: {
    marginLeft: 6, // optical centering for the play triangle
  },
  infoWrap: {
    position: 'absolute',
    maxWidth: '58%',
  },
  infoWrapExpanded: {
    maxWidth: '78%',
  },
  infoPanel: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 3,
  },
  infoRowTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  infoDate: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '700',
  },
  favoriteIndicator: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 87, 122, 0.18)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 156, 178, 0.56)',
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: 'rgba(0,0,0,0.35)',
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  badgeText: {
    color: colors.textMuted,
    fontSize: 9,
    fontWeight: '600',
  },
  infoPlace: {
    color: colors.textMuted,
    fontSize: 12,
  },
  infoDetails: {
    marginTop: 7,
    paddingTop: 7,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.18)',
    gap: 5,
  },
  detailLine: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
  },
  detailText: {
    flex: 1,
    color: 'rgba(255,255,255,0.82)',
    fontSize: 11,
    lineHeight: 15,
  },
  cardTypeBadgeWrap: {
    position: 'absolute',
    top: 14,
    left: 14,
    zIndex: 35,
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
});
