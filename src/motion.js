import { useSyncExternalStore } from 'react';
import { AccessibilityInfo, Animated, Easing } from 'react-native';
import { MOTION, planExit, springVelocity } from './motionCore.mjs';

export { MOTION } from './motionCore.mjs';

// One native setting subscription for all cards/buttons, with no frame listeners
// or per-card native queries. Stay quiet until the initial setting is known.
let reduced = true;
let subscription = null;
let generation = 0;
const listeners = new Set();
const snapshot = () => reduced;
function subscribe(listener) {
  listeners.add(listener);
  if (!subscription) {
    const version = ++generation;
    let eventReceived = false;
    const publish = value => {
      if (version !== generation || reduced === Boolean(value)) return;
      reduced = Boolean(value);
      listeners.forEach(notify => notify());
    };
    subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', value => {
      eventReceived = true;
      publish(value);
    });
    AccessibilityInfo.isReduceMotionEnabled().then(value => {
      if (!eventReceived) publish(value);
    }).catch(() => {});
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      generation++;
      subscription?.remove();
      subscription = null;
    }
  };
}

export function useReducedMotion() {
  return useSyncExternalStore(subscribe, snapshot, () => true);
}

export function settleMotion(value, toValue, { velocity, reduced = false, scale = false } = {}) {
  if (reduced) return fadeMotion(value, toValue, MOTION.reducedMs);
  return Animated.spring(value, {
    ...MOTION.spring,
    toValue,
    ...(Number.isFinite(velocity) ? { velocity: springVelocity(velocity) } : {}),
    restDisplacementThreshold: scale ? 0.0005 : 0.25,
    restSpeedThreshold: scale ? 0.005 : 2,
    useNativeDriver: true,
    isInteraction: false,
  });
}

export function fadeMotion(value, toValue, duration = MOTION.fadeMs) {
  return Animated.timing(value, {
    toValue, duration, easing: Easing.out(Easing.quad),
    useNativeDriver: true, isInteraction: false,
  });
}

export function exitMotion(value, from, toValue, velocity, reduced = false, travelScale = 1) {
  const { duration, bezier } = planExit(from * travelScale, toValue * travelScale, velocity * travelScale, reduced);
  return Animated.timing(value, {
    toValue, duration, easing: Easing.bezier(...bezier),
    useNativeDriver: true, isInteraction: false,
  });
}

// Presentation handoff only: the existing responder still owns arbitration
// and commit thresholds. Native stop callbacks can arrive after another move.
export function beginMotionDrag(value, state, displacement) {
  const version = ++state.version;
  state.dragging = true;
  state.ready = false;
  state.latest = displacement;
  state.onReady = null;
  value.stopAnimation(position => {
    if (state.version !== version || !state.dragging) return;
    state.origin = Math.abs(position) > 0.5 ? position - displacement : 0;
    state.ready = true;
    moveMotionDrag(value, state, state.latest);
    const onReady = state.onReady;
    state.onReady = null;
    onReady?.();
  });
}

export function moveMotionDrag(value, state, displacement) {
  state.latest = displacement;
  if (!state.ready || !state.dragging) return;
  state.position = Math.max(state.min ?? -Infinity, state.origin + displacement);
  value.setValue(state.position);
}
