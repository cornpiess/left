// Motion changes presentation only. Gesture thresholds, paging and media
// ownership deliberately stay in their existing controllers.
export const MOTION = Object.freeze({
  spring: Object.freeze({ mass: 1, stiffness: 500, damping: 45, overshootClamping: true }),
  feedbackMs: 220,
  fadeMs: 160,
  reducedMs: 90,
  pressScale: 0.975,
  swipeTilt: 2,
  burstScale: 0.99,
  burstDeck: Object.freeze({ spacing: 26, tilt: 2.5, scaleStep: 0.03, maxTravel: 2 }),
  dayTilt: 4,
  pulseScale: 1.05,
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// PanResponder reports points/ms; Animated.spring expects points/second.
export function springVelocity(velocity) {
  return Number.isFinite(velocity) ? clamp(velocity, -4, 4) * 1000 : 0;
}

/** A bounded exit with a tangent that matches the release, rather than
 * restarting a fixed ease-in from rest. Velocity is in points/ms. */
export function planExit(from, to, velocity = 0, reduced = false) {
  const distance = to - from;
  if (Math.abs(distance) < 1) return { duration: 0, bezier: [0, 0, 1, 1] };
  const speed = Number.isFinite(velocity) ? velocity : 0;
  const forwardSpeed = Math.max(0, speed * Math.sign(distance));
  const duration = reduced
    ? MOTION.reducedMs
    : clamp(Math.abs(distance) / (1.5 + forwardSpeed * 0.5), 120, 220);
  // x1 = 1/3 makes y1*3 the initial slope. Limit extreme/noisy samples,
  // while retaining a small reverse tangent when the finger changes its mind.
  const slope = clamp(speed * duration / distance, -0.3, 2.4);
  return { duration, bezier: [1 / 3, slope / 3, 2 / 3, 2 / 3] };
}
