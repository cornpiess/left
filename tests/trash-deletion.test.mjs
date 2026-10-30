import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrashDeletion } from '../src/trashDeletion.mjs';

for (const count of [100, 1000, 10000]) {
  test(`${count} assets use one native request and commit only after success`, async () => {
    const ids = Array.from({ length: count }, (_, i) => `asset-${i}`);
    let calls = 0;
    let committed = false;
    const run = createTrashDeletion({
      getIds: () => ids,
      remove: async (received) => {
        calls++;
        assert.deepEqual(received, ids);
        assert.equal(committed, false);
        return true;
      },
      commit: async (received) => {
        assert.deepEqual(received, new Set(ids));
        committed = true;
      },
    });
    assert.equal(await run(), count);
    assert.equal(calls, 1);
    assert.equal(committed, true);
  });
}

test('rapid repeated calls share a transaction until persistence finishes', async () => {
  let finishNative, finishCommit, nativeCalls = 0, commits = 0;
  const run = createTrashDeletion({
    getIds: () => ['a'],
    remove: () => { nativeCalls++; return new Promise(r => { finishNative = r; }); },
    commit: () => { commits++; return new Promise(r => { finishCommit = r; }); },
  });
  const first = run();
  assert.equal(run(), first);
  while (!finishNative) await new Promise(resolve => setImmediate(resolve));
  finishNative(true);
  while (!finishCommit) await new Promise(resolve => setImmediate(resolve));
  assert.equal(run(), first);
  assert.equal(nativeCalls, 1);
  finishCommit();
  assert.equal(await first, 1);
  assert.equal(commits, 1);
});

test('cancel/rejection retains state, does not split or retry, and unlocks for explicit retry', async () => {
  let calls = 0, commits = 0;
  const run = createTrashDeletion({
    getIds: () => ['a', 'b'],
    remove: async () => { if (++calls === 1) throw Error('cancelled'); return true; },
    commit: async () => { commits++; },
  });
  await assert.rejects(run(), /cancelled/);
  assert.equal(calls, 1);
  assert.equal(commits, 0);
  assert.equal(await run(), 2);
  assert.equal(commits, 1);
});

test('false and ambiguous native results never remove pending records', async () => {
  for (const result of [false, undefined, null]) {
    let commits = 0;
    const run = createTrashDeletion({ getIds: () => ['a'], remove: async () => result, commit: () => { commits++; } });
    assert.equal(await run(), 0);
    assert.equal(commits, 0);
  }
});

test('empty bin never contacts native; IDs are unique and snapshotted', async () => {
  const ids = [];
  const received = [];
  const run = createTrashDeletion({ getIds: () => ids, remove: async a => { received.push(a); return true; }, commit: async () => {} });
  assert.equal(await run(), 0);
  assert.equal(received.length, 0);
  ids.push('a', 'a', 'b');
  const pending = run();
  ids.push('later');
  assert.equal(await pending, 2);
  assert.deepEqual(received, [['a', 'b']]);
});

// Execute the production media coordinator with native/IO boundaries replaced.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
async function coordinator(nativeResult) {
  const media = await readFile(new URL('../src/media.js', import.meta.url), 'utf8');
  const body = media.slice(media.indexOf('const deletePendingTrash'), media.indexOf('/** Extract the paired video'))
    .replaceAll('export async function', 'async function');
  const state = { calls: 0, reloads: 0, writes: 0 };
  const ctx = vm.createContext({
    createTrashDeletion, USE_MOCK: false, Set, Promise,
    ensureReviewState: async () => {},
    deleteAssetsWithSystemConfirmation: (ids,fn) => fn(ids),
    reviewStore: {
      flush: async () => {},
      jobs: async () => [],
      trashPage: async () => [{ id: 'a', size_bytes: 10 }, { id: 'b', size_bytes: 20 }],
      beginDeletion: async () => { state.writes++; },
      abandonDeletion: async () => { state.writes++; },
      completeDeletion: async () => { state.writes++; return true; },
    },
    trashIds: new Set(['a', 'b']), mockTrashIds: new Set(),
    cachedAssets: [{ id: 'a' }, { id: 'b' }, { id: 'keep' }],
    trashItemsListCache: [{ id: 'a', fileSize: 10 }, { id: 'b', fileSize: 20 }],
    totalCleanedSizeBytes: 100,
    MediaLibrary: { deleteAssetsAsync: async () => { state.calls++; return nativeResult(); } },
    withLibraryReloadSuppression: fn => fn().finally(() => { state.reloads++; }),
    persistCleanedHistory: async () => { state.writes++; },
    flushTrashHistory: async () => { state.writes++; },
    flightEvent: () => {},
  });
  vm.runInContext(body + '\nglobalThis.run = emptyTrash;', ctx);
  return { ctx, state };
}

test('production coordinator commits only the snapshot and coalesces concurrent calls', async () => {
  const { ctx, state } = await coordinator(() => true);
  const first = ctx.run();
  const second = ctx.run();
  ctx.trashIds.add('newly-added');
  assert.deepEqual(await Promise.all([first, second]), [2, 2]);
  assert.deepEqual(state, { calls: 1, reloads: 1, writes: 2 });
  assert.deepEqual([...ctx.trashIds], ['newly-added']);
  assert.equal(ctx.totalCleanedSizeBytes, 130);
  assert.deepEqual(Array.from(ctx.cachedAssets, a => a.id), ['keep']);
  assert.equal(ctx.trashItemsListCache.length, 0);
});

test('production coordinator retains all pending records and accounting on cancellation', async () => {
  const { ctx, state } = await coordinator(() => { throw Error('cancel'); });
  await assert.rejects(ctx.run(), /cancel/);
  assert.equal(ctx.trashIds.size, 2);
  assert.equal(ctx.trashItemsListCache.length, 2);
  assert.equal(ctx.totalCleanedSizeBytes, 100);
  assert.deepEqual(state, { calls: 1, reloads: 1, writes: 2 });
});
test('native success followed by persistence failure retains journal and never auto-retries deletion',async()=>{
 let nativeCalls=0,cancels=0;
 const run=createTrashDeletion({getIds:()=>['a'],before:async()=>({id:'journal'}),remove:async()=>{nativeCalls++;return true;},commit:async()=>{throw Error('disk full');},cancel:async()=>{cancels++;}});
 await assert.rejects(run(),/disk full/);assert.equal(nativeCalls,1);assert.equal(cancels,0);
});
