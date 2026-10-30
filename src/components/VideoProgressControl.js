import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, PanResponder, StyleSheet, View } from 'react-native';

export default function VideoProgressControl({ player, bottom }) {
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const trackWidthRef = useRef(0);
  const scrubbingRef = useRef(false);
  const resumeRef = useRef(false);
  const expand = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!player) return undefined;
    try {
      setPosition(player.currentTime || 0);
      setDuration(player.duration || 0);
      // The visible bar only animates meaningfully at ~2 updates/sec; 5/sec
      // was doubling bridge traffic while MemoryVideo already persists the
      // resume position on its own (0.5s) subscription.
      player.timeUpdateEventInterval = 0.5;
    } catch {}

    let timeSub = null;
    let statusSub = null;

    try {
      timeSub = player.addListener('timeUpdate', ({ currentTime }) => {
        if (!scrubbingRef.current) setPosition(currentTime || 0);
      });
      statusSub = player.addListener('statusChange', ({ status }) => {
        if (status === 'readyToPlay') {
          try {
            setDuration(player.duration || 0);
          } catch {}
        }
      });
    } catch {}

    return () => {
      try { timeSub?.remove(); } catch {}
      try { statusSub?.remove(); } catch {}
    };
  }, [player]);

  const setFromTouch = useCallback(
    (locationX) => {
      const width = trackWidthRef.current;
      const next = duration > 0 && width > 0 ? Math.min(Math.max(locationX / width, 0), 1) * duration : 0;
      setPosition(next);
      return next;
    },
    [duration]
  );

  const settle = useCallback(() => {
    Animated.spring(expand, { toValue: 0, useNativeDriver: false, speed: 26, bounciness: 4 }).start();
  }, [expand]);

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onStartShouldSetPanResponderCapture: () => false,
        onMoveShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponderCapture: () => false,
        onPanResponderGrant: (event) => {
          scrubbingRef.current = true;
          try {
            resumeRef.current = !!player?.playing;
            player?.pause();
          } catch {}
          Animated.spring(expand, { toValue: 1, useNativeDriver: false, speed: 30, bounciness: 5 }).start();
          setFromTouch(event.nativeEvent.locationX);
        },
        onPanResponderMove: (event) => setFromTouch(event.nativeEvent.locationX),
        onPanResponderRelease: (event) => {
          const next = setFromTouch(event.nativeEvent.locationX);
          try {
            if (player) player.currentTime = next;
          } catch {}
          scrubbingRef.current = false;
          try {
            if (resumeRef.current) player?.play();
          } catch {}
          settle();
        },
        onPanResponderTerminate: () => {
          scrubbingRef.current = false;
          try {
            if (resumeRef.current) player?.play();
          } catch {}
          settle();
        },
      }),
    [expand, player, setFromTouch, settle]
  );

  if (!player || duration <= 0) return null;
  const progress = Math.min(Math.max(position / duration, 0), 1);
  const trackHeight = expand.interpolate({ inputRange: [0, 1], outputRange: [1.5, 6] });
  const thumbScale = expand.interpolate({ inputRange: [0, 1], outputRange: [1, 1.5] });

  return (
    <View style={[styles.wrap, { bottom }]} pointerEvents="box-none">
      <View
        style={styles.touchArea}
        onLayout={(event) => {
          trackWidthRef.current = event.nativeEvent.layout.width;
        }}
        {...responder.panHandlers}
      >
        <Animated.View style={[styles.track, { height: trackHeight }]}>
          <View style={styles.trackBase} pointerEvents="none" />
          <View style={[styles.trackFill, { width: `${progress * 100}%` }]} pointerEvents="none" />
          <Animated.View
            style={[styles.thumb, { left: `${progress * 100}%`, transform: [{ scale: thumbScale }] }]}
            pointerEvents="none"
          />
        </Animated.View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 20,
    right: 20,
    zIndex: 10,
  },
  touchArea: {
    height: 32,
    justifyContent: 'center',
  },
  track: {
    justifyContent: 'center',
    borderRadius: 8,
  },
  trackBase: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  trackFill: {
    height: '100%',
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.72)',
  },
  thumb: {
    position: 'absolute',
    top: '50%',
    width: 8,
    height: 8,
    marginLeft: -4,
    marginTop: -4,
    borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.88)',
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
  },
});
