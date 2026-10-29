import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mapLimit, createReloadCoalescer } from '../src/asyncUtils.mjs';
import { planFeedPrefetch, getLocalDayKey } from '../src/mediaPage.mjs';

const readSource = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------- mapLimit (trash enrichment / bounded concurrency) ----------------

test('mapLimit keeps at most `limit` mappers in flight and preserves order (perf #1)', async () => {
  const items = Array.from({ length: 10 }, (_, i) => i);
  let inFlight = 0;
  let peak = 0;
  const results = await mapLimit(items, 3, async (item) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await delay(5 + (item % 3) * 3);
    inFlight -= 1;
    return item * 10;
  });
  assert.ok(peak <= 3, `peak concurrency ${peak} exceeded limit 3`);
  assert.deepEqual(results, items.map((i) => i * 10), 'results must keep input order');
});

test('mapLimit handles edges: empty input, oversized limit, rejection propagation (perf #2)', async () => {
  assert.deepEqual(await mapLimit([], 5, async (x) => x), []);
  assert.deepEqual(await mapLimit([1, 2], 50, async (x) => x + 1), [2, 3]);
  await assert.rejects(() => mapLimit([1, 2, 3], 2, async (x) => {
    if (x === 2) throw new Error('boom');
    return x;
  }), /boom/);
});

// ---------------- createReloadCoalescer (library-reload storm merging) ----------------

test('reload coalescer: one emit, suppressed events merge into one trailing emit (perf #3)', () => {
  const c = createReloadCoalescer({ cooldownMs: 8000 });
  assert.equal(c.accept(1000), 'emit', 'first event emits');
  assert.equal(c.accept(4000), 'suppress', 'event inside cooldown is suppressed');
  assert.equal(c.accept(7000), 'suppress', 'second suppressed event still merges');
  assert.equal(c.takeTrailing(7500), false, 'trailing must wait out the cooldown');
  assert.equal(c.takeTrailing(9500), true, 'exactly one trailing emit after cooldown');
  assert.equal(c.takeTrailing(10000), false, 'no double trailing emits');
  assert.equal(c.accept(10000), 'suppress', 'next storm starts suppressed (cooldown restarts)');
});

test('reload coalescer: force emits immediately and reset clears state (perf #4)', () => {
  const c = createReloadCoalescer({ cooldownMs: 8000 });
  assert.equal(c.accept(1000), 'emit');
  assert.equal(c.accept(2000, true), 'emit', 'forced emit bypasses cooldown (batch deletion)');
  assert.equal(c.takeTrailing(9000), false, 'force clears the pending trailing event');
  c.reset();
  assert.equal(c.accept(0), 'emit', 'after reset the coalescer emits again');
});

// ---------------- planFeedPrefetch (prefetch storm reduction) ----------------

test('planFeedPrefetch bounds the entry window and caps burst frames (perf #5)', () => {
  const frame = (id) => ({ id, displayUri: `file://${id}` });
  const feed = [
    { unit: { items: [frame('a1')] } },                                        // single
    { unit: { items: Array.from({ length: 9 }, (_, i) => frame(`b${i}`)) } },  // 9-frame burst
    { unit: { items: [frame('c1')] } },
    { unit: { items: [frame('d1')] } },
    { unit: { items: [frame('e1')] } },
  ];
  const uris = planFeedPrefetch(feed, 0, { entryWindow: 3, framesPerEntry: 2 });
  assert.deepEqual(uris, ['file://a1', 'file://b0', 'file://b1', 'file://c1'],
    '3 entries, burst capped at 2 frames, later entries untouched');
  assert.deepEqual(planFeedPrefetch(feed, 4, { entryWindow: 3, framesPerEntry: 2 }), ['file://e1'],
    'window clamps at the feed end');
  assert.deepEqual(planFeedPrefetch([], 0, {}), []);
  assert.deepEqual(planFeedPrefetch(feed, -3, { entryWindow: 2, framesPerEntry: 2 }).length, 3,
    'negative index clamps to 0 (a1 + 2 burst frames)');
});

// ---------------- getLocalDayKey (allocation-free day grouping) ----------------

test('getLocalDayKey groups timestamps exactly like local calendar days (perf #6)', () => {
  const dateKey = (ts) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  };
  const base = new Date(2026, 0, 15, 12, 0, 0).getTime(); // local noon
  for (let i = 0; i < 300; i++) {
    const ts = base + (i - 150) * 47 * 60 * 1000 + ((i * 977) % 60) * 1000;
    assert.equal(getLocalDayKey(ts) === getLocalDayKey(ts), true);
    const sameDay = getLocalDayKey(ts);
    const expected = dateKey(ts);
    // Same partition: two timestamps share a key iff they share a Y-M-D.
    const other = ts + 3 * 60 * 60 * 1000; // +3h may cross midnight
    assert.equal(
      sameDay === getLocalDayKey(other),
      expected === dateKey(other),
      `partition mismatch at ts=${ts}`
    );
  }
  assert.equal(getLocalDayKey(0), '', 'epoch-ish/zero creationTime returns empty');
  assert.equal(getLocalDayKey(NaN), '');
  assert.equal(getLocalDayKey(undefined), '');
});

// ---------------- source assertions: crash-side hardening ----------------

test('feed prefetch storm is bounded in both directions (perf #7)', async () => {
  const [home, card] = await Promise.all([
    readSource('../src/screens/HomeScreen.js'),
    readSource('../src/components/MemoryCard.js'),
  ]);
  assert.match(home, /planFeedPrefetch\(feed, activeIndex/, 'HomeScreen must plan prefetches through the bounded planner');
  assert.doesNotMatch(home, /activeIndex \+ 6/, 'the 6-entry full-frame window must be gone');
  assert.match(home, /PREFETCH_ENTRY_WINDOW = 3/);
  assert.match(card, /BURST_PREFETCH_RADIUS = 2/, 'burst deck prefetch must be windowed, not whole-deck');
  assert.match(card, /supportsNativePhotoPreview \|\| !active/);
  assert.doesNotMatch(card, /setInterval\(/, 'no whole-deck backfill while browsing');
});


test('library-reload storms are coalesced and batch deletions suppressed (perf #9)', async () => {
  const media = await readSource('../src/media.js');
  assert.match(media, /createReloadCoalescer\(\{ cooldownMs: LIBRARY_RELOAD_COOLDOWN_MS \}\)/);
  const listener = media.match(/MediaLibrary\.addListener\(\(event\) => \{[\s\S]*?\n  \}\);/)?.[0] || '';
  assert.match(listener, /emitLibraryReloadRequired\(\);/, 'change events must go through the coalescer');
  const emptyTrash = media.match(/export async function emptyTrash\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(emptyTrash, /withLibraryReloadSuppression/, 'emptyTrash must fold its deletions into one reload');
  assert.match(media, /flightEvent\('library-reload'/, 'reloads must be recorded');
});

test('trash metadata is paged and weak-network inspection stays bounded (perf #10)', async () => {
  const media = await readSource('../src/media.js');
  assert.match(media, /fetchTrashItems\(limit = 120, offset = 0\)/);
  assert.match(media, /reviewStore\.trashPage\(limit, offset\)/);
});

test('video card render path is staggered, size-bounded and quiet in release (perf #11)', async () => {
  const [card, progress] = await Promise.all([
    readSource('../src/components/MemoryCard.js'),
    readSource('../src/components/VideoProgressControl.js'),
  ]);
  assert.match(card, /VIDEO_THUMB_OPTIONS = \{ time: 0, maxWidth: 1200 \}/, 'poster thumbnails must be size-bounded');
  assert.doesNotMatch(card, /VIDEO_MOUNT_DELAY_MS|setVideoMounted/);
  assert.match(card, /const showVideo = isVideo && \(active \|\| keepMotion\)/);
  assert.equal((card.match(/timeUpdateEventInterval = 0\.5/g) || []).length >= 1, true, 'timeUpdate must tick at 2/s, not 5/s');
  assert.match(progress, /timeUpdateEventInterval = 0\.5/);
  assert.match(card, /if \(!__DEV__ \|\| !active \|\| !item\?\.id\) return;/, 'per-card diagnostics logs must be DEV-only');
  assert.match(card, /recyclingKey=\{stillSource\}/, 'main still must carry a recycling key');
});

test('HomeScreen render blast radius is reduced: memoized data and panels (perf #12)', async () => {
  const [home, panel, media] = await Promise.all([
    readSource('../src/screens/HomeScreen.js'),
    readSource('../src/components/MemoryInfoPanel.js'),
    readSource('../src/media.js'),
  ]);
  assert.match(home, /const listData = useMemo\(\(\) => \{/, 'FlatList data must be a stable memoized reference');
  assert.match(home, /data=\{listData\}/);
  assert.match(panel, /export default memo\(MemoryInfoPanel\)/, 'info panel must not reconcile on every HomeScreen render');
  assert.match(media, /loadItemBasicsInFlight/, 'loadItemBasics must dedupe concurrent callers');
});

// ---------------- source assertions: local flight recorder ----------------

test('flight recorder is local-only and surfaced via the version row long-press (perf #13)', async () => {
  const [recorder, menu, home, i18nIndex] = await Promise.all([
    readSource('../src/flightRecorder.js'),
    readSource('../src/components/MoreMenuModal.js'),
    readSource('../src/screens/HomeScreen.js'),
    readSource('../src/i18n/index.js'),
  ]).catch(async () => {
    // i18n/index.js may not exist; the locale files are what matter.
    return Promise.all([
      readSource('../src/flightRecorder.js'),
      readSource('../src/components/MoreMenuModal.js'),
      readSource('../src/screens/HomeScreen.js'),
      Promise.resolve(''),
    ]);
  });
  assert.match(recorder, /AsyncStorage/, 'persistence must be AsyncStorage (on-device)');
  assert.doesNotMatch(recorder, /fetch\(|XMLHttpRequest|https?:\/\//, 'PRD 3.10: zero network access');
  assert.match(recorder, /abnormal-exit/, 'un-ended sessions must be flagged for post-crash reading');
  assert.match(menu, /onLongPress=\{handleVersionLongPress\}/, 'diagnostics open via version-row long-press');
  assert.match(menu, /getFlightLogText/, 'menu must read the recorder, nothing else');
  assert.match(home, /initFlightRecorder\(\)/, 'HomeScreen must boot the recorder');

  const locales = ['zh-Hans', 'zh-Hant', 'en', 'ja', 'ko', 'es'];
  for (const lang of locales) {
    const file = await readSource(`../src/i18n/locales/${lang}.js`);
    assert.match(file, /diagnosticsTitle/, `${lang} must carry the diagnostics keys`);
  }
});

