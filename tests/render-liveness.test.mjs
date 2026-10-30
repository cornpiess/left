import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatGpsCoordinate } from '../src/mediaPage.mjs';

// ---- GPS coordinate label (info panel location row) ----
test('formats northern/eastern coordinates', () => {
  assert.equal(formatGpsCoordinate({ latitude: 31.2304, longitude: 121.4737 }), '31.2304° N, 121.4737° E');
});
test('formats southern/western coordinates with sign letters, not minus', () => {
  assert.equal(formatGpsCoordinate({ latitude: -33.8688, longitude: -118.2437 }), '33.8688° S, 118.2437° W');
});
test('rejects missing or out-of-range locations', () => {
  assert.equal(formatGpsCoordinate(null), '');
  assert.equal(formatGpsCoordinate({}), '');
  assert.equal(formatGpsCoordinate({ latitude: 120, longitude: 10 }), '');
  assert.equal(formatGpsCoordinate({ latitude: 'x', longitude: 2 }), '');
});

// ---- Render pipeline liveness protocol (native sources cannot execute in
// node tests; these source-level gates pin the contract) ----
const swift = readFileSync(new URL('../modules/maoqiu-photo-preview/ios/PhotoResources.swift', import.meta.url), 'utf8');
const swiftView = readFileSync(new URL('../modules/maoqiu-photo-preview/ios/MaoqiuPhotoPreviewModule.swift', import.meta.url), 'utf8');

test('every scheduler drop path notifies its callbacks as cancelled', () => {
  // cancelBackground, pump eviction and window disable must all route
  // through notifyCancelled — a silent drop leaves the view black forever.
  assert.match(swift, /cancelBackground\(\)[\s\S]{0,120}notifyCancelled/);
  assert.match(swift, /pixels > 8_000_000[\s\S]{0,80}notifyCancelled\(background\)/);
  assert.match(swift, /!enabled[\s\S]{0,400}notifyCancelled\(task\)/);
});
test('cancelled views re-arm instead of staying black', () => {
  assert.match(swiftView, /if wasCancelled[\s\S]{0,700}setNeedsLayout\(\)/);
});
test('errors are reported at every priority, not only priority 0', () => {
  const gated = /requestPriority == 0 \{ onError/;
  assert.equal(gated.test(swiftView), false, 'onError must not be gated on priority');
});
test('neighbour requests may fetch from iCloud', () => {
  assert.match(swift, /priority <= 1 \|\| allowNetwork/);
});
test('visible burst stack cards use neighbour priority', () => {
  const card = readFileSync(new URL('../src/components/MemoryCard.js', import.meta.url), 'utf8');
  assert.doesNotMatch(card, /stackCardImg.*priority=\{2\}/);
  assert.match(card, /maxPixelSize=\{512\} priority=\{1\}/);
});

// ---- Scroll liveness failsafe ----
test('all scrolling flags are failsafe-armed, never raw useState', () => {
  for (const file of ['src/screens/HomeScreen.js', 'src/components/DayMemoryCarousel.js']) {
    const code = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(code, /useState\(false\);\s*\/\/ scrolling/, file);
    assert.match(code, /useScrollLiveness\(\)/, file + ' must use useScrollLiveness');
  }
});
test('useScrollLiveness releases armed flags even without an end event', async () => {
  const code = readFileSync(new URL('../src/useScrollLiveness.js', import.meta.url), 'utf8');
  assert.match(code, /setTimeout\(\(\) => setActive\(false\), timeoutMs\)/);
});

// ---- Ambient backdrop heals after a dropped request ----
test('ambient backdrop requeues a pending layer that never settled', () => {
  const code = readFileSync(new URL('../src/components/AmbientBackdrop.js', import.meta.url), 'utf8');
  assert.match(code, /setNextUri\(current => \(current === null \? uri : current\)\)/);
});
