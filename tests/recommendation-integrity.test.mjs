import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowseSession } from '../src/browseSession.mjs';
import { createCandidatePager } from '../src/candidatePager.mjs';
import { runtime, photo } from './support/media-runtime.mjs';

const unit = item => ({ items: [item] });

test('native expansion cannot reclaim a frame already committed to another card', async () => {
  const members = [photo('n0', 10000), photo('n1', 20000), photo('n2', 30000)];
  const r = runtime(members, undefined, { nativeBursts: { native: members } });
  const owner = await r.media.openBrowseSession();
  owner.ingest([
    unit({ ...members[0], nativeBurstId: 'native', suppressBurstRegroup: true }),
    unit({ ...members[1], nativeBurstId: 'native' }),
  ]);
  await r.media.fetchMemoryPage();
  const ids = owner.state.entries.flatMap(e => e.unit.items.map(i => i.id));
  assert.equal(new Set(ids).size, ids.length, 'native expansion must use the same reservation as normal ingestion');
});

test('new native members discovered after their deck was committed remain eligible exactly once', () => {
  const s = createBrowseSession();
  const member = id => photo(id, 10000, { nativeBurstId: 'native' });
  s.ingest([unit(member('a'))]); s.take(1);
  s.ingest([unit(member('b')), unit(member('c'))]);
  const next = s.take(10).flatMap(e => e.unit.items);
  assert.deepEqual(new Set(next.map(i => i.id)), new Set(['b', 'c']));
  assert.ok(next.every(i => i.suppressBurstRegroup), 'late members must not mutate a committed deck');
});

test('a failed eligibility read retries the same catalog page instead of skipping it', async () => {
  let fail = true;
  const cursors = [];
  const pager = createCandidatePager({
    fetchPage: async o => { cursors.push(o.after || 'start'); return { assets: [photo('a', 10000)], hasNextPage: false, endCursor: 'end' }; },
    eligible: async items => { if (fail) { fail = false; throw Error('database unavailable'); } return items; },
    group: items => items.map(unit), order: units => units,
  });
  await assert.rejects(pager.next(10), /database unavailable/);
  assert.deepEqual((await pager.next(10)).flatMap(u => u.items.map(i => i.id)), ['a']);
  assert.deepEqual(cursors, ['start', 'start']);
});

test('a deck metadata cap preserves every discovered native member', async () => {
  const { assignBursts, buildBurstUnits } = await import('../src/burst.js');
  const members = Array.from({ length: 180 }, (_, i) => photo('n' + i, 10000 + i * 10000, { nativeBurstId: 'native' }));
  assignBursts(members);
  const units = buildBurstUnits(members);
  assert.equal(units[0].items.length, 160);
  assert.deepEqual(new Set(units.flatMap(u => u.items.map(i => i.id))), new Set(members.map(i => i.id)));
});

test('expanding offset zero retains a sampled seed beyond the first 160 native members', async () => {
  const members = Array.from({ length: 180 }, (_, i) => photo('n' + i, 10000 + i * 10000));
  const r = runtime([members[179]], undefined, { nativeBursts: { native: members } });
  const page = await r.media.fetchMemoryPage();
  assert.ok(page.items.some(i => i.id === 'n179'), 'expansion must not discard the original representative');
});

test('history cropping updates the owning session so a refill cannot resurrect its old prefix', () => {
  const s = createBrowseSession();
  s.ingest(Array.from({ length: 120 }, (_, i) => unit(photo('p' + i, 10000 + i * 10000))));
  const entries = s.take(82);
  entries.forEach(e => s.expose(e.unit.items[0].id));
  s.anchor(entries[80].unit.items[0].id);
  const anchor = s.state.anchorId, frontier = s.state.frontier;
  s.trimBefore(entries[40].key);
  s.take(2);
  assert.equal(s.feed()[0].key, entries[40].key);
  assert.equal(s.feed().findIndex(e => e.unit.items.some(i => i.id === anchor)), 40);
  assert.equal(s.state.frontier, frontier);
  const cold = createBrowseSession({ snapshot: s.snapshot() });
  assert.equal(cold.state.anchorId, anchor);
  assert.equal(cold.feed()[0].key, entries[40].key);
});

test('older overlapping snapshots recover with one owner per asset across all queues', () => {
  const s = createBrowseSession(); s.ingest([unit(photo('a', 10000)), unit(photo('b', 20000))]); s.take(1);
  const snapshot = s.snapshot();
  snapshot.candidates.push({ key: 'old-overlap', unit: { items: [photo('a', 10000)] } });
  snapshot.overflow.push(unit(photo('b', 20000)));
  snapshot.deferred.push(photo('b', 20000));
  const restored = createBrowseSession({ snapshot });
  const ids = [...restored.state.entries, ...restored.state.candidates].flatMap(e => e.unit.items.map(i => i.id))
    .concat(restored.state.overflow.flatMap(u => u.items.map(i => i.id)), restored.state.deferred.map(i => i.id));
  assert.deepEqual(ids, ['a', 'b']);
});

test('same-day review removes future cards while retaining the active and earlier history', async () => {
  const assets = Array.from({ length: 8 }, (_, i) => photo('p' + i, 10000 + i * 10000));
  const r = runtime(assets), m = r.media;
  const first = await m.fetchMemoryPage();
  const s = m.getBrowseSession(), anchor = first.items[0], future = first.items[1];
  s.anchor(anchor.id); s.expose(anchor.id); await m.markAssetViewed(anchor);
  s.enterDay([future], future.id, anchor.id); await m.markAssetViewed(future);
  assert.ok(!s.feed().some(e => e.unit.items.some(i => i.id === future.id)), 'a prefetched duplicate is removed before returning from the day');
  s.leaveDay();
  await m.fetchMemoryPage();
  assert.ok(s.feed().some(e => e.unit.items.some(i => i.id === anchor.id)), 'history is still available for explicit backtracking');
  assert.ok(!s.feed().some(e => e.unit.items.some(i => i.id === future.id)), 'day-reviewed content cannot remain in front of the user');
});

for (const mode of ['default', 'storage']) test(`${mode}: 5000 photos, bounded history, restart beyond the hot-cache limit, zero repeats or omissions`, async () => {
  const assets = Array.from({ length: 5000 }, (_, i) => photo('p' + i, 100000 + i * 10000,
    i % 7 === 0 ? { mediaType: 'video', duration: 30 } : {}));
  let r = runtime(assets), m = r.media;
  await m.openBrowseSession(); await m.setRecommendMode(mode);
  const seen = new Set(); let restarted = false, complete = false;
  for (let pageNumber = 0; pageNumber < 2700; pageNumber++) {
    const page = await m.fetchMemoryPage(50, 'next'), s = m.getBrowseSession();
    for (const item of page.items) {
      assert.ok(!seen.has(item.id), `repeated ${item.id} at ${seen.size}`);
      seen.add(item.id); s.anchor(item.id); s.expose(item.id); await m.markAssetViewed(item);
    }
    if (s.state.entries.length > 80) s.trimBefore(s.state.entries.at(-40).key);
    assert.ok(s.state.entries.length <= 80);
    if (!restarted && seen.size >= 4200) {
      await m.persistBrowseSession();
      r = runtime(assets, r.store); m = r.media;
      await m.openBrowseSession(); await m.setRecommendMode(mode); restarted = true;
    }
    if (!page.hasNextPage) { complete = true; break; }
  }
  assert.ok(restarted); assert.ok(complete, 'must reach completion without cycling');
  assert.equal(seen.size, assets.length);
  assert.equal((await r.store.load()).count, assets.length);
  assert.equal((await m.fetchMemoryPage()).items.length, 0, 'exhaustion must not reshuffle the library');
});

test('native-only catalog traversal covers 1080 members without repeating or losing capped tails', async () => {
  const nativeBursts = Object.fromEntries(Array.from({ length: 6 }, (_, g) => ['g' + g,
    Array.from({ length: 180 }, (_, i) => photo(`g${g}-${i}`, 100000 + g * 10000000 + i * 10000))]));
  const assets = Object.values(nativeBursts).flat();
  const r = runtime(assets, undefined, { nativeBursts }), m = r.media, seen = new Set();
  let completed = false;
  for (let p = 0; p < 700; p++) {
    const page = await m.fetchMemoryPage(), owner = m.getBrowseSession();
    for (const item of page.items) {
      assert.ok(!seen.has(item.id), `native member repeated: ${item.id}`); seen.add(item.id);
      owner.anchor(item.id); owner.expose(item.id); await m.markAssetViewed(item);
    }
    if (owner.state.entries.length > 80) owner.trimBefore(owner.state.entries.at(-40).key);
    if (!page.hasNextPage) { completed = true; break; }
  }
  assert.ok(completed);
  assert.deepEqual(seen, new Set(assets.map(i => i.id)));
});
