/**
 * Pure helpers for the whole-library spread sampler (used by media.js).
 *
 * The initial feed must stay spread across all eras (8 time buckets), but each
 * bucket must sample a TIME-CONTIGUOUS neighborhood instead of "the newest N in
 * a wide window": burst decks only form from frames within a few seconds of
 * each other, so a temporally dispersed sample can never regroup into decks
 * (regression that shipped in Build 27). Each bucket therefore picks a random
 * anchor and pulls the N photos nearest to it in time — contiguous chunks keep
 * natural photo-session clusters intact, and assignBursts can deck them.
 */

export const SAMPLE_BUCKETS = 8;

/** Divide the library span into `buckets` equal time buckets of `count` each. */
export function planSpreadBuckets(oldestTime, newestTime, limit, buckets = SAMPLE_BUCKETS) {
  if (!(newestTime > oldestTime) || !(limit > 0)) return [];
  const span = newestTime - oldestTime;
  const count = Math.max(1, Math.ceil(limit / buckets));
  const list = [];
  for (let i = 0; i < buckets; i += 1) {
    list.push({
      start: oldestTime + (span * i) / buckets,
      end: oldestTime + (span * (i + 1)) / buckets,
      count,
    });
  }
  return list;
}

/** Uniform random anchor inside a bucket (injectable random for tests). */
export function pickBucketAnchor(bucket, random = Math.random) {
  return bucket.start + random() * (bucket.end - bucket.start);
}

/**
 * Merge the forward page (assets from the anchor ascending) and the backfill
 * page (assets before the anchor descending) into one deduped, time-sorted
 * sample of at most `bucket.count` assets nearest to the anchor.
 */
export function mergeContiguousBucketSample(forwardAssets, backfillAssets, bucket, anchor) {
  const seen = new Set();
  const pool = [];
  for (const asset of [...(forwardAssets || []), ...(backfillAssets || [])]) {
    if (!asset?.id || seen.has(asset.id)) continue;
    seen.add(asset.id);
    pool.push(asset);
  }
  if (pool.length <= bucket.count) {
    pool.sort((a, b) => (a.creationTime || 0) - (b.creationTime || 0));
    return pool;
  }
  pool.sort((a, b) => (a.creationTime || 0) - (b.creationTime || 0));
  // Binary search the first asset at/after the anchor, then expand outward,
  // always taking whichever side is temporally closer to the anchor.
  let lo = 0;
  let hi = pool.length - 1;
  let idx = pool.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((pool[mid].creationTime || 0) >= anchor) {
      idx = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  const taken = new Set();
  let left = idx - 1;
  let right = idx;
  while (taken.size < bucket.count && (left >= 0 || right < pool.length)) {
    const leftDist = left >= 0 ? anchor - (pool[left].creationTime || 0) : Infinity;
    const rightDist = right < pool.length ? (pool[right].creationTime || 0) - anchor : Infinity;
    if (leftDist <= rightDist) {
      taken.add(left);
      left -= 1;
    } else {
      taken.add(right);
      right += 1;
    }
  }
  return pool.filter((_, i) => taken.has(i));
}
