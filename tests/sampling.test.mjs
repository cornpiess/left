import test from 'node:test';
import assert from 'node:assert/strict';
import { planSpreadBuckets, pickBucketAnchor, mergeContiguousBucketSample } from '../src/sampling.mjs';
import { assignBursts, buildBurstUnits } from '../src/burst.js';

const DAY = 24 * 60 * 60 * 1000;

test('planSpreadBuckets covers the whole span with equal, non-overlapping buckets', () => {
  const buckets = planSpreadBuckets(0, 8 * DAY, 240);
  assert.equal(buckets.length, 8);
  assert.equal(buckets[0].start, 0);
  assert.equal(buckets.at(-1).end, 8 * DAY);
  for (let i = 1; i < buckets.length; i += 1) {
    assert.equal(buckets[i].start, buckets[i - 1].end);
  }
  assert.ok(buckets.every((b) => b.count === 30));
});

test('planSpreadBuckets rejects invalid ranges', () => {
  assert.deepEqual(planSpreadBuckets(0, 0, 240), []);
  assert.deepEqual(planSpreadBuckets(100, 50, 240), []);
  assert.deepEqual(planSpreadBuckets(0, 100, 0), []);
});

test('pickBucketAnchor stays inside its bucket', () => {
  const bucket = { start: 10 * DAY, end: 20 * DAY, count: 30 };
  for (let i = 0; i < 100; i += 1) {
    const anchor = pickBucketAnchor(bucket, () => 0.42);
    assert.ok(anchor >= bucket.start && anchor <= bucket.end);
  }
});

test('mergeContiguousBucketSample dedupes, sorts by time and trims to the bucket count', () => {
  const bucket = { start: 0, end: 100 * DAY, count: 3 };
  const anchor = 50 * DAY;
  const forward = [
    { id: 'f1', creationTime: 51 * DAY },
    { id: 'f2', creationTime: 52 * DAY },
    { id: 'dup', creationTime: 53 * DAY },
  ];
  const backfill = [
    { id: 'dup', creationTime: 53 * DAY },
    { id: 'b1', creationTime: 49 * DAY },
    { id: 'b2', creationTime: 47 * DAY },
  ];
  const merged = mergeContiguousBucketSample(forward, backfill, bucket, anchor);
  assert.deepEqual(merged.map((a) => a.id), ['b1', 'f1', 'f2']);
});

test('a contiguous-neighborhood sample still groups into burst decks across all eras', () => {
  // Clustered library: photo-session clusters (<=15s apart) separated by days.
  const photos = [];
  const now = 1_800_000_000_000;
  let t = now - 730 * DAY;
  while (photos.length < 400) {
    const clusterSize = 2 + Math.floor(Math.random() * 8);
    const clusterStart = t;
    for (let i = 0; i < clusterSize && photos.length < 400; i += 1) {
      photos.push({ id: `p${photos.length}`, creationTime: Math.round(clusterStart + i * 500), width: 3024, height: 4032 });
    }
    t += (1 + Math.random() * 10) * DAY;
  }
  photos.sort((a, b) => a.creationTime - b.creationTime);
  const oldest = photos[0].creationTime;
  const newest = photos.at(-1).creationTime;
  const buckets = planSpreadBuckets(oldest, newest, 240);
  const sample = [];
  const seen = new Set();
  const coveredBuckets = new Set();
  for (const bucket of buckets) {
    const anchor = pickBucketAnchor(bucket);
    const forward = photos
      .filter((p) => p.creationTime >= anchor && p.creationTime <= bucket.end)
      .slice(0, bucket.count);
    const backfill = photos
      .filter((p) => p.creationTime < anchor && p.creationTime >= bucket.start)
      .slice(-bucket.count);
    for (const asset of mergeContiguousBucketSample(forward, backfill, bucket, anchor)) {
      if (seen.has(asset.id)) continue;
      seen.add(asset.id);
      coveredBuckets.add(buckets.indexOf(bucket));
      sample.push(asset);
    }
  }
  // All 8 eras are represented in the sample (exploration intent preserved).
  assert.equal(coveredBuckets.size, 8);
  // The temporally contiguous chunks let the burst classifier build decks.
  assignBursts(sample);
  const decks = buildBurstUnits(sample).filter((unit) => unit.items.length > 1);
  assert.ok(decks.length >= 5, `Expected a healthy deck supply in the initial sample, got ${decks.length}`);
});

test('a temporally dispersed sample (one photo per neighborhood) yields no decks', () => {
  const photos = Array.from({ length: 400 }, (_, i) => ({
    id: `p${i}`,
    creationTime: i * 3 * DAY,
    width: 3024,
    height: 4032,
  }));
  assignBursts(photos);
  assert.equal(buildBurstUnits(photos).filter((unit) => unit.items.length > 1).length, 0);
});
