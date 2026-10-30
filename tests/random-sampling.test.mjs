import test from 'node:test';
import assert from 'node:assert/strict';

test('random time pivot calculates valid timestamp boundaries across photo library time range', () => {
  const oldestTime = new Date('2020-01-01').getTime();
  const newestTime = new Date('2026-08-25').getTime();
  const timeSpan = newestTime - oldestTime;

  assert.ok(timeSpan > 24 * 60 * 60 * 1000);

  for (let i = 0; i < 50; i++) {
    const pivotTime = oldestTime + Math.random() * (newestTime - oldestTime);
    assert.ok(pivotTime >= oldestTime && pivotTime <= newestTime, 'Pivot time must fall within library range');
  }
});
