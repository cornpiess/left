import { useLayoutEffect, useMemo, useRef } from 'react';
import { Animated } from 'react-native';
import { MOTION, settleMotion } from './motion';

const stillPoses = Array.from({ length: 4 }, (_, slot) => [
  { translateY: slot * MOTION.burstDeck.spacing },
  { rotate: `${-slot * MOTION.burstDeck.tilt}deg` },
  { scale: 1 - slot * MOTION.burstDeck.scaleStep },
]);

/** One native spring for the entire existing deck, without extra media views.
 * The target advances by a card; the driver retains its position and velocity.
 * When a back card becomes the front card its depth therefore stays continuous,
 * including when another tap arrives before the previous turn has settled. */
export default function useBurstMotion({ itemId, enabled, directionRef, reduced }) {
  const driver = useRef(new Animated.Value(0)).current;
  const target = useRef(new Animated.Value(0)).current;
  const destination = useRef(0);
  const previousId = useRef(itemId);
  const animation = useRef(null);

  useLayoutEffect(() => {
    const changed = previousId.current !== itemId;
    previousId.current = itemId;
    const direction = directionRef.current;
    directionRef.current = 0;
    if (!enabled || reduced || (changed && !direction)) {
      animation.current?.stop();
      animation.current = null;
      driver.stopAnimation();
      driver.setValue(0);
      target.setValue(0);
      destination.current = 0;
      return;
    }
    if (!changed || !direction) return;
    if (!animation.current) {
      // Track a native target node, rather than creating a fresh spring for
      // each tap. React Native's tracking driver reuses its animation ID and
      // updates the target with the actual native position AND velocity.
      animation.current = settleMotion(driver, target, { scale: true });
      animation.current.start();
    }
    destination.current += Math.sign(direction);
    target.setValue(destination.current);
  }, [itemId, enabled, reduced, directionRef, driver, target]);

  useLayoutEffect(() => () => {
    animation.current?.stop();
    driver.stopAnimation();
  }, [driver]);

  return useMemo(() => {
    if (!enabled || reduced) return stillPoses;
    const depth = Animated.subtract(target, driver);
    const { spacing, tilt, scaleStep, maxTravel } = MOTION.burstDeck;
    // Reuse the front + the existing three back surfaces. The cap is purely
    // visual: unusually fast tapping cannot throw cards far off the stage.
    return Array.from({ length: 4 }, (_, slot) => {
      const inputRange = [-maxTravel, 0, maxTravel];
      const interpolate = outputRange => depth.interpolate({ inputRange, outputRange, extrapolate: 'clamp' });
      const levels = [slot - maxTravel, slot, slot + maxTravel];
      return [
        { translateY: interpolate(levels.map(level => level * spacing)) },
        { rotate: interpolate(levels.map(level => `${-level * tilt}deg`)) },
        { scale: interpolate(levels.map(level => 1 - level * scaleStep)) },
      ];
    });
  }, [driver, target, enabled, reduced]);
}
