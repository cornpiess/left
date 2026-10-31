import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createOfflineRegionLookup } from '../src/offlineRegions.mjs';

const data = JSON.parse(readFileSync(new URL('../src/data/china-regions.json', import.meta.url), 'utf8'));
const lookup = createOfflineRegionLookup(data);

test('the bundled index contains provinces and cities without adding expanded coordinate copies', () => {
  assert.equal(data.provinces.length, 34);
  assert.equal(data.cities.length, 372);
  assert.ok(data.arcs.length > 0);
  assert.ok(readFileSync(new URL('../src/data/china-regions.json', import.meta.url)).length < 1200000);
});

test('GPS resolves to actual province/city boundaries, including islands and border prefectures', () => {
  for (const [latitude, longitude, expected] of [
    [31.2304, 121.4737, '上海市'], [39.9042, 116.4074, '北京市'],
    [36.067, 120.382, '山东省 · 青岛市'], [30.244, 122.205, '浙江省 · 舟山市'],
    [25.03, 98.497, '云南省 · 保山市'], [24.01, 97.85, '云南省 · 德宏傣族景颇族自治州'],
    [32.04, 120.86, '江苏省 · 南通市'], [22.3, 114.17, '香港特别行政区'],
  ]) {
    assert.equal(lookup({ latitude, longitude }), expected);
  }
});

test('invalid/uncovered positions stay empty instead of guessing a city or returning raw GPS', () => {
  for (const point of [null, {}, { latitude: NaN, longitude: 120 }, { latitude: 91, longitude: 1 },
    { latitude: 1, longitude: -181 }, { latitude: '31', longitude: 120 },
    { latitude: 0, longitude: 0 }, { latitude: 48.8566, longitude: 2.3522 }]) {
    assert.equal(lookup(point), '');
  }
});

test('polygon holes, reversed arcs and disjoint islands preserve containment semantics', () => {
  const province = ['010000', '省', 'Province', [0, 0, 30, 30], [[[0]], [[2]]]];
  const city = ['010100', '市', 'City', [0, 0, 30, 30], [[[~0], [1]], [[2]]]];
  const resolve = createOfflineRegionLookup({
    transform: { scale: [1, 1], translate: [0, 0] }, provinces: [province], cities: [city],
    arcs: [
      [[0, 0], [10, 0], [0, 10], [-10, 0], [0, -10]],
      [[2, 2], [2, 0], [0, 2], [-2, 0], [0, -2]],
      [[20, 20], [10, 0], [0, 10], [-10, 0], [0, -10]],
    ],
  });
  assert.equal(resolve({ latitude: 1, longitude: 1 }), '省 · 市');
  assert.equal(resolve({ latitude: 3, longitude: 3 }), '省');
  assert.equal(resolve({ latitude: 25, longitude: 25 }), '省 · 市');
  assert.equal(resolve({ latitude: 15, longitude: 15 }), '');
});
