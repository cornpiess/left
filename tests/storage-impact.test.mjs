import test from 'node:test';
import assert from 'node:assert/strict';
import { computeStorageImpactScore, sortAndShuffleByStorageImpact } from '../src/mediaPage.mjs';

test('computeStorageImpactScore weights videos and large burst units higher than small photos', () => {
  const smallPhotoUnit = {
    items: [{ id: 'photo-1', mediaType: 'photo', fileSizeBytes: 2 * 1024 * 1024 }],
  };

  const largeVideoUnit = {
    items: [{ id: 'video-1', mediaType: 'video', duration: 60000, fileSizeBytes: 250 * 1024 * 1024 }],
  };

  const burstUnit = {
    items: Array.from({ length: 10 }, (_, i) => ({
      id: `burst-${i}`,
      mediaType: 'photo',
      fileSizeBytes: 5 * 1024 * 1024,
    })),
  };

  const photoScore = computeStorageImpactScore(smallPhotoUnit);
  const videoScore = computeStorageImpactScore(largeVideoUnit);
  const burstScore = computeStorageImpactScore(burstUnit);

  assert.ok(videoScore > photoScore, 'Video score should be much higher than a single small photo');
  assert.ok(burstScore > photoScore, 'Burst set score should be higher than a single small photo');
  assert.equal(Math.round(photoScore), 2);
  assert.ok(videoScore >= 250);
});

test('sortAndShuffleByStorageImpact places large impact units ahead of standard photos', () => {
  const smallPhotoUnit = {
    items: [{ id: 'photo-1', mediaType: 'photo', fileSizeBytes: 1 * 1024 * 1024 }],
  };

  const largeVideoUnit = {
    items: [{ id: 'video-1', mediaType: 'video', duration: 30000, fileSizeBytes: 100 * 1024 * 1024 }],
  };

  const burstUnit = {
    items: Array.from({ length: 8 }, (_, i) => ({
      id: `burst-${i}`,
      mediaType: 'photo',
      fileSizeBytes: 4 * 1024 * 1024,
    })),
  };

  const units = [smallPhotoUnit, largeVideoUnit, burstUnit];
  const sorted = sortAndShuffleByStorageImpact(units);

  assert.equal(sorted.length, 3);
  const lastUnit = sorted[sorted.length - 1];
  assert.equal(lastUnit.items[0].id, 'photo-1', 'Small photo should be sorted behind high impact units');
});

test('legacy video duration stays in seconds and storage priority is monotonic across ten minutes', () => {
  const score = duration => computeStorageImpactScore({ items: [{ id: 'v', mediaType: 'video', duration }] });
  assert.ok(score(601) > score(600));
  assert.ok(score(3600) > score(601));
  assert.ok(Number.isFinite(score(NaN)));
});
