// One local policy for grouping, scheduling and durable session versions.
export const DEFAULT_ALGORITHM_CONFIG = Object.freeze({
  groupingVersion: 2,
  schedulerVersion: 1,
  burstGapMs: 2000,
  burstWindowMs: 15000,
  minBurstSize: 2,
  aspectTolerance: 0.05,
  maxGroupMetadata: 160,
  openingSingles: 2,
  minSinglesBetweenBursts: 3,
  maxSinglesBetweenBursts: 5,
  initialSampleSize: 240,
  candidateLimit: 480,
  lookAheadEntries: 2,
});
let activeAlgorithmConfig = { ...DEFAULT_ALGORITHM_CONFIG };
export function getAlgorithmConfig() { return activeAlgorithmConfig; }
export function updateAlgorithmConfig(config) {
  if (config && typeof config === 'object') activeAlgorithmConfig = { ...activeAlgorithmConfig, ...config };
  return activeAlgorithmConfig;
}
export function resetAlgorithmConfig() {
  activeAlgorithmConfig = { ...DEFAULT_ALGORITHM_CONFIG };
  return activeAlgorithmConfig;
}
