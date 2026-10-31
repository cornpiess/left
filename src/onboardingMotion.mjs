// Seconds on a single, native-driven decorative timeline. Text and action never gate entry.
export const ONBOARDING_CYCLE_MS = 7200;
export const CARD_HEIGHT = 186;
export const PAGE_TRAVEL = 218;
export const SCENE_WIDTH = 280;
export const SCENE_HEIGHT = 266;

// Scale one fixed vector scene as a whole. Keep typography/art in proportion,
// and use the measured content space rather than a phone-height breakpoint.
export function onboardingSceneLayout(availableWidth, availableHeight) {
  const scale = Math.max(0, Math.min(availableWidth / SCENE_WIDTH, availableHeight / SCENE_HEIGHT, 1.8));
  return { width: SCENE_WIDTH * scale, height: SCENE_HEIGHT * scale, scale };
}
const TRACKS = {
  firstY: [[0, 0], [1.1, 0], [1.65, -218], [5.4, -218], [5.4, 218], [5.7, 218], [6.3, 0], [7.2, 0]],
  selectedY: [[0, 218], [1.1, 218], [1.65, 0], [6.4, 0], [6.4, 218], [7.2, 218]],
  selectedX: [[0, 0], [3.6, 0], [4.25, -1], [6.5, -1], [6.5, 0], [7.2, 0]],
  selectedAngle: [[0, 0], [3.3, 0], [3.65, -7], [4.25, -11], [6.5, -11], [6.5, 0], [7.2, 0]],
  neutralLabel: [[0, 1], [2.8, 1], [3.05, 0], [6.5, 0], [6.5, 1], [7.2, 1]],
  decisionLabel: [[0, 0], [2.8, 0], [3.05, 1], [6.5, 1], [6.5, 0], [7.2, 0]],
  leftArrow: [[0, 0], [3.3, 0], [3.55, 1], [6.5, 1], [6.5, 0], [7.2, 0]],
  nextY: [[0, 218], [2, 218], [2, 0], [5.7, 0], [6.3, -218], [6.5, -218], [6.5, 218], [7.2, 218]],
  firstMemory: [[0, 1], [.75, 1], [1, 0], [5.4, 0], [5.4, 1], [7.2, 1]],
  firstKeep: [[0, 0], [.75, 0], [1, 1], [5.4, 1], [5.4, 0], [7.2, 0]],
  nextMemory: [[0, 1], [5, 1], [5.25, 0], [6.5, 0], [6.5, 1], [7.2, 1]],
  nextKeep: [[0, 0], [5, 0], [5.25, 1], [6.5, 1], [6.5, 0], [7.2, 0]],
  receipt: [[0, 0], [4.25, 0], [4.5, 1], [6.15, 1], [6.4, 0], [7.2, 0]],
};
const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

// Offscreen resets have zero duration; all visible movement is eased, never faded.
// Native interpolation supports equal adjacent input values for instantaneous hidden resets.
export function motionConfig(name, exitDistance = 340) {
  const points = TRACKS[name];
  if (!points) throw new Error(`Unknown motion track: ${name}`);
  const inputRange = [], outputRange = [];
  const output = value => name === 'selectedAngle' ? `${value}deg` : name === 'selectedX' ? value * exitDistance : value;
  for (let i = 0; i < points.length - 1; i++) {
    const [start, from] = points[i], [end, to] = points[i + 1];
    const steps = from === to || start === end ? 1 : 12;
    for (let step = 0; step < steps; step++) {
      const fraction = step / steps;
      inputRange.push((start + (end - start) * fraction) * 1000 / ONBOARDING_CYCLE_MS);
      outputRange.push(output(from + (to - from) * ease(fraction)));
    }
  }
  inputRange.push(1); outputRange.push(output(points[points.length - 1][1]));
  return { inputRange, outputRange, extrapolate: 'clamp' };
}
