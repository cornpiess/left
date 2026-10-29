import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowseSession } from '../src/browseSession.mjs';
import { runtime, photo, database, fileStore } from './support/media-runtime.mjs';
import { renderComponent, flatten } from './support/render-component.mjs';

const library = () => Array.from({ length: 12 }, (_, i) => photo('p' + i, 10000 + i * 10000));

test('native burst merging across batches retains the candidate budget and native count', () => {
  const session = createBrowseSession();
  session.ingest([{ items: [photo('a', 1000, { nativeBurstId: 'native', nativeBurstCount: 5 })] }]);
  session.ingest([{ items: [photo('b', 2000, { nativeBurstId: 'native' })] }, { items: [photo('single', 30000)] }]);
  assert.equal(session.candidateCount, 3);
  assert.deepEqual(session.state.candidates[0].unit.items.map(i => i.id), ['a', 'b']);
  assert.equal(session.state.candidates[0].unit.items[1].nativeBurstCount, 5);
  session.ingest([{ items: [photo('b', 2000, { nativeBurstId: 'native' })] }]);
  assert.equal(session.candidateCount, 3);
});

test('first load with the same native burst in both sampling and paging reaches real photos', async () => {
  const a = photo('a', 100000), b = photo('b', 101000), s1 = photo('s1', 10000), s2 = photo('s2', 20000);
  let batches = 0;
  const r = runtime([a, b, s1, s2], undefined, {
    nativeBursts: { native: [a, b] },
    query: async o => o.first === 240 && ++batches === 1
      ? { assets: [a, s1, s2], hasNextPage: false, endCursor: null } : undefined,
  });
  const first = await r.media.fetchMemoryPage();
  assert.equal(first.status, 'ready');
  assert.equal(first.items.length, 2);
  for (const item of first.items) r.media.getBrowseSession().expose(item.id);
  const next = await r.media.fetchMemoryPage();
  assert.deepEqual([...next.units[0].unit.items.map(i => i.id)], ['a', 'b']);
  assert.ok(next.items.every(i => i.previewUri?.startsWith('ph://')));
});

test('fresh install runs the actual filesystem migration and native adapter before showing photos', async () => {
  const r = runtime(library(), fileStore());
  assert.equal((await r.media.fetchMemoryPage()).status, 'ready');
  assert.equal((await r.store.load()).count, 0);
  assert.ok((await r.store.loadBrowse()).snapshot);
});

test('upgrade reads actual legacy files without resetting reviews, pending items or cleaned bytes', async () => {
  const files = {
    'file:///documents/vibe-viewed-assets.json': '["p0"]',
    'file:///documents/vibe-trash-assets.json': '["p1"]',
    'file:///documents/vibe-cleaned-history.json': '12345',
    'file:///documents/vibe-membership.json': '{"date":"today","usedToday":30}',
  };
  const r = runtime(library(), fileStore(files));
  const result = await r.media.fetchMemoryPage();
  assert.equal(result.status, 'ready');
  assert.ok(result.items.every(i => !['p0', 'p1'].includes(i.id)));
  const state = await r.store.load();
  assert.equal(state.count, 1); assert.deepEqual([...state.trash], ['p1']); assert.equal(state.bytes, 12345);
});

test('query rejection remains an error and a fresh retry rereads an available library', async () => {
  let failing = true;
  const r = runtime(library(), undefined, { beforeQuery: async () => { if (failing) throw Error('PhotoKit temporarily unavailable'); } });
  await assert.rejects(r.media.fetchMemoryPage(), e => e.photoLoadStage === 'library-query');
  assert.ok(r.events.some(([k, v]) => k === 'photo-load-failed' && v.stage === 'library-query'));
  failing = false;
  await r.media.retryBrowseSession();
  assert.equal((await r.media.fetchMemoryPage()).status, 'ready');
});

test('a genuinely empty first query is not cached for the next retry', async () => {
  const assets = [], r = runtime(assets);
  assert.equal((await r.media.fetchMemoryPage()).status, 'empty-library');
  assets.push(...library());
  await r.media.retryBrowseSession();
  assert.equal((await r.media.fetchMemoryPage()).status, 'ready');
});

test('retry invalidates old source work without letting it consume the recovered feed', async () => {
  let release, started, wait = true;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const r = runtime(library(), undefined, { beforeQuery: async () => {
    if (wait) { wait = false; started(); await gate; }
  } });
  const old = r.media.fetchMemoryPage(); await entered;
  const owner = await r.media.retryBrowseSession();
  release(); assert.equal((await old).stale, true);
  assert.equal(owner.state.entries.length, 0);
  const next = await r.media.fetchMemoryPage();
  assert.equal(next.status, 'ready'); assert.equal(next.items.length, 2);
  assert.equal(r.media.getBrowseSession(), owner);
});

test('native validation failure falls back to PhotoKit info without deleting the saved anchor', async () => {
  const assets = library(), r = runtime(assets), first = await r.media.fetchMemoryPage();
  const id = first.items[1].id; r.media.getBrowseSession().anchor(id); await r.media.persistBrowseSession();
  const cold = runtime(assets, r.store, { nativeModule: {
    getAccessibleAssetIds: async () => { throw Error('bridge unavailable'); },
  } });
  assert.equal((await cold.media.openBrowseSession()).state.anchorId, id);
  assert.ok(cold.events.some(([k]) => k === 'asset-validation-fallback'));
});

test('native grouping bridge failure cannot block base browsing', async () => {
  for (const nativeModule of [{}, { getBurstIdentifiers: async () => { throw Error('native failure'); } }]) {
    const r = runtime(library(), undefined, { nativeModule });
    assert.equal((await r.media.fetchMemoryPage()).status, 'ready');
  }
});

test('failed native burst expansion keeps the representative and the unconsumed continuation', async () => {
  const r = runtime(library(), undefined, { nativeModule: {
    getBurstIdentifiers: async ids => Object.fromEntries(ids.map(id => [id, 'native'])),
    getBurstMembers: async () => { throw Error('native failure'); },
  } });
  const s = await r.media.openBrowseSession();
  s.state.continuations.push({ nativeId: 'older', nativeOffset: 160, nativeCount: 350 });
  assert.equal((await r.media.fetchMemoryPage()).status, 'ready');
  assert.equal(s.state.continuations[0].nativeOffset, 160);
});

test('snapshot write failure does not turn a successfully read library into an error page', async () => {
  const store = database(), save = store.saveBrowse;
  store.saveBrowse = async () => { throw Error('checkpoint write failed'); };
  const r = runtime(library(), store);
  assert.equal((await r.media.fetchMemoryPage()).status, 'ready');
  assert.ok(r.events.some(([k]) => k === 'browse-save-failed'));
  store.saveBrowse = save;
  assert.equal(await r.media.persistBrowseSession(), true);
});

test('retry preserves the active anchor, cadence, reviewed history, pending state and allowance', async () => {
  const r = runtime(library()), m = r.media;
  const first = await m.fetchMemoryPage(), s = m.getBrowseSession();
  const current = first.items[0]; s.anchor(current.id); s.expose(current.id); await m.markAssetViewed(current);
  await r.store.selectForCleanup('pending', { date: 'today', charge: true, limit: 100 });
  const rhythm = { ...s.state.rhythm };
  assert.equal(await m.retryBrowseSession(), s);
  assert.equal(s.state.anchorId, current.id); assert.deepEqual(s.state.rhythm, rhythm);
  assert.equal((await r.store.load()).count, 1); assert.equal(await r.store.dailyUsage('today'), 1);
  assert.deepEqual([...(await r.store.load()).trash], ['pending']);
  assert.equal((await m.fetchMemoryPage()).status, 'ready');
});

test('store startup failures retry through the real adapter without marking migration complete', async () => {
  const files = { 'file:///documents/vibe-viewed-assets.json': '{broken' };
  const store = fileStore(files), r = runtime(library(), store);
  await assert.rejects(r.media.openBrowseSession(), e => e.photoLoadStage === 'review-store');
  files['file:///documents/vibe-viewed-assets.json'] = '["p0"]';
  await r.media.retryBrowseSession();
  assert.equal((await r.media.fetchMemoryPage()).status, 'ready');
  assert.equal((await store.load()).count, 1);
});

test('retry checks current permission and distinguishes denial from internal failures', async () => {
  let granted = false;
  const r = runtime(library(), undefined, { permission: () => ({ granted }) });
  await assert.rejects(r.media.retryBrowseSession(), e => e.photoLoadStage === 'permission');
  granted = true; await r.media.retryBrowseSession();
  assert.equal((await r.media.fetchMemoryPage()).status, 'ready');
});

test('the actual Home retry button shows loading, blocks duplicate taps and recovers to photos', async () => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const r = runtime(library(), undefined, { beforeQuery: async () => { started(); await gate; } });
  const c = renderComponent('screens/HomeScreen.js', { accessPrivileges: 'all' }, { '../media': r.media });
  c.render(); c.slots[1] = false; c.slots[2] = 'error'; c.slots[3] = Error('previous failure');
  const button = flatten(c.render()).find(n => n.props.onPress && n.children.some(x => x?.children?.includes('home.retryBtn')));
  assert.ok(button);
  const pending = button.props.onPress({ nativeEvent: {} });
  await entered;
  assert.equal(c.slots[1], true);
  assert.equal(button.props.onPress(), undefined);
  assert.ok(flatten(c.render()).some(n => n.children.includes('home.loadingHint')));
  release(); await pending;
  assert.equal(c.slots[1], false); assert.equal(c.slots[2], 'ready'); assert.equal(c.slots[3], null);
  assert.ok(c.slots[0].length > 0);
});
