// Seconds on a single, native-driven decorative timeline. Text and action never gate entry.
export const ONBOARDING_CYCLE_MS = 7200;
const TRACKS = {
  firstY: [[0, 0], [1.1, 0], [1.65, -226], [6.5, -226], [6.51, 0], [7.2, 0]],
  firstOpacity: [[0, 1], [1.3, 1], [1.65, 0], [6.5, 0], [6.51, 0], [7, 1], [7.2, 1]],
  selectedY: [[0, 226], [1.1, 226], [1.65, 0], [3.6, 0], [4.25, 16], [6.5, 16], [6.51, 226], [7.2, 226]],
  selectedX: [[0, 0], [3.6, 0], [4.25, -1], [6.5, -1], [6.51, 0], [7.2, 0]],
  selectedAngle: [[0, 0], [3.3, 0], [3.65, -7], [4.25, -11], [6.5, -11], [6.51, 0], [7.2, 0]],
  selectedOpacity: [[0, 0], [1.1, 0], [1.5, 1], [4.1, 1], [4.25, 0], [7.2, 0]],
  neutralLabel: [[0, 1], [2.8, 1], [3.05, 0], [6.5, 0], [6.51, 1], [7.2, 1]],
  decisionLabel: [[0, 0], [2.8, 0], [3.05, 1], [4.1, 1], [4.25, 0], [7.2, 0]],
  leftArrow: [[0, 0], [3.3, 0], [3.55, 1], [4.1, 1], [4.25, 0], [7.2, 0]],
  nextY: [[0, 226], [4.05, 226], [4.6, 0], [6.65, 0], [6.66, 226], [7.2, 226]],
  nextOpacity: [[0, 0], [4.05, 0], [4.4, 1], [6.2, 1], [6.65, 0], [7.2, 0]],
  receipt: [[0, 0], [4.25, 0], [4.5, 1], [6.2, 1], [6.65, 0], [7.2, 0]],
};
const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

// Sample easing into native interpolation nodes: smooth motion without JS frame updates.
export function motionConfig(name, exitDistance = 340) {
  const points = TRACKS[name];
  if (!points) throw new Error(`Unknown motion track: ${name}`);
  const inputRange = [], outputRange = [];
  const output = value => name === 'selectedAngle' ? `${value}deg` : name === 'selectedX' ? value * exitDistance : value;
  for (let i = 0; i < points.length - 1; i++) {
    const [start, from] = points[i], [end, to] = points[i + 1];
    const steps = from === to ? 1 : 12;
    for (let step = 0; step < steps; step++) {
      const fraction = step / steps;
      inputRange.push((start + (end - start) * fraction) * 1000 / ONBOARDING_CYCLE_MS);
      outputRange.push(output(from + (to - from) * ease(fraction)));
    }
  }
  inputRange.push(1); outputRange.push(output(points[points.length - 1][1]));
  return { inputRange, outputRange, extrapolate: 'clamp' };
}
