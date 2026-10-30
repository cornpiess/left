import { DAILY_FREE_LIMIT as LIMIT } from '../src/membershipCore.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createReviewStore, RecentIds } from '../src/reviewStore.mjs';
function adapter(database) {
  const db = {
    execAsync: async sql => database.exec(sql),
    runAsync: async (sql,...params) => database.prepare(sql).run(...params),
    getFirstAsync: async (sql,...params) => database.prepare(sql).get(...params),
    getAllAsync: async (sql,...params) => database.prepare(sql).all(...params),
    withExclusiveTransactionAsync: async fn => {
      database.exec('BEGIN IMMEDIATE');
      try { const result = await fn(db); database.exec('COMMIT'); return result; }
      catch (error) { database.exec('ROLLBACK'); throw error; }
    },
  };
  return db;
}
function setup(legacy = { viewed: [], trash: [], bytes: 0 }) {
  const sql = new DatabaseSync(':memory:');
  const db = adapter(sql);
  return { sql, db, store: createReviewStore({ open: async () => db, readLegacy: async () => legacy }) };
}
test('migration preserves more than 15,000 reviews and loads only a hot window', async () => {
  const { store,db } = setup({ viewed: Array.from({length:20000},(_,i)=>`p-${i}`), trash:['a','b'], bytes:42 });
  const state = await store.load();
  assert.equal(state.count,20000); assert.equal(state.recent.length,2048);
  assert.deepEqual(state.trash,['a','b']); assert.equal(state.bytes,42);
  assert.deepEqual([...await store.reviewed(['p-0','p-19999','new'])],['p-0','p-19999']);
  await store.clearReviewed();
  const reopened = createReviewStore({ open: async()=>db, readLegacy:()=>{throw Error('must not migrate again');} });
  assert.equal((await reopened.load()).count,0);
  assert.deepEqual((await reopened.load()).trash,['a','b']);
});
test('failed legacy migration is retryable and never silently resets history', async () => {
  const {db}=setup(); let fail=true;
  const store=createReviewStore({open:async()=>db,readLegacy:async()=>{if(fail)throw Error('read failed');return {viewed:['a']};}});
  await assert.rejects(store.init(),/read failed/);
  assert.equal(await db.getFirstAsync("SELECT value FROM meta WHERE key='migration-v1'"),undefined);
  fail=false; assert.equal((await store.load()).count,1);
});
test('review, restore, reset and retry serialize without resurrecting cleared history', async () => {
  const {store}=setup();
  const outcomes=await Promise.all([store.review('a'),store.review('a'),store.setPending('a',true),store.clearReviewed(),store.setPending('a',false)]);
  assert.deepEqual(outcomes.slice(0,2),[true,false]);
  const state=await store.load();assert.equal(state.count,0);assert.deepEqual(state.trash,[]);
});
test('deletion journal is durable before native work and accounting commits atomically once', async () => {
  const {store,db}=setup({viewed:['a','b'],trash:['a','b'],bytes:10});
  await store.beginDeletion('job',{ids:['a','b'],sizes:{a:20,b:30}});
  assert.equal((await store.jobs()).length,1);
  assert.equal(await store.completeDeletion('job',['a'],20,{ids:['b'],sizes:{b:30}}),true);
  assert.deepEqual((await store.load()).trash,['b']);
  const reopened=createReviewStore({open:async()=>db,readLegacy:async()=>{throw Error('already migrated');}});
  assert.deepEqual((await reopened.jobs())[0].ids,['b']);
  await reopened.completeDeletion('job',['b'],30);
  assert.equal(await reopened.completeDeletion('job',['b'],30),false);
  assert.equal((await reopened.load()).bytes,60);
  assert.deepEqual((await reopened.load()).trash,[]);
  assert.equal((await reopened.load()).count,2);
});
test('cancellation removes only the operation journal and retains all pending assets',async()=>{
  const {store}=setup({trash:['a'],viewed:[],bytes:0});
  await store.beginDeletion('cancel',{ids:['a'],sizes:{a:20}});
  await store.abandonDeletion('cancel');
  assert.equal((await store.jobs()).length,0); assert.deepEqual((await store.load()).trash,['a']);assert.equal((await store.load()).bytes,0);
});
test('recent IDs are bounded without deleting durable review rows',async()=>{
  const ids=new RecentIds(2);ids.add('a').add('b').add('c');assert.deepEqual([...ids],['b','c']);
  const {store}=setup();await store.review('a');ids.delete('a');assert.ok((await store.reviewed(['a'])).has('a'));
});
test('pending-bin summaries aggregate all items while pages stay bounded and ordered',async()=>{
 const {store}=setup();
 for(let i=0;i<260;i++)await store.setPending(`p${i}`,true,i%2?10:null);
 const summary=await store.trashSummary();assert.equal(summary.count,260);assert.equal(summary.unknown_count,130);assert.equal(summary.known_bytes,1300);
 const first=await store.trashPage(120,0),second=await store.trashPage(120,120),third=await store.trashPage(120,240);
 assert.equal(first.length,120);assert.equal(second.length,120);assert.equal(third.length,20);
 assert.equal(new Set([...first,...second,...third].map(row=>row.id)).size,260);
 await store.setPending(first[0].id,false);assert.equal((await store.trashSummary()).count,259);
});
test('100 distinct selections commit atomically with pending state and survive reopening',async()=>{
 const {store,db}=setup();const quota={date:'today',charge:true,limit:LIMIT};
 for(let i=0;i<LIMIT+20;i++)await store.review(`p${i}`);
 assert.equal(await store.dailyUsage('today'),0);
 const results=await Promise.all(Array.from({length:LIMIT+1},(_,i)=>store.selectForCleanup(`p${i}`,quota)));
 assert.equal(results.filter(r=>r.allowed).length,LIMIT);assert.equal((await store.trashSummary()).count,LIMIT);
 assert.equal((await store.load()).count,LIMIT+20);assert.equal(await store.dailyUsage('today'),LIMIT);
 await store.setPending('p0',false);
 assert.equal((await store.selectForCleanup('p0',quota)).allowed,true);assert.equal(await store.dailyUsage('today'),LIMIT);
 const reopened=createReviewStore({open:async()=>db,readLegacy:async()=>({})});
 assert.equal(await reopened.dailyUsage('today'),LIMIT);await reopened.clearReviewed();assert.equal(await reopened.dailyUsage('today'),LIMIT);
 await reopened.resetQuota('today');assert.equal(await reopened.dailyUsage('today'),0);
});
test('duplicates, restoration, next day and Pro share one per-asset cleaning contract',async()=>{
 const {store}=setup({trash:['legacy'],viewed:[],bytes:0});const q={date:'today',charge:true,limit:LIMIT};
 const results=await Promise.all([store.selectForCleanup('a',q),store.selectForCleanup('a',q)]);
 assert.deepEqual(results.map(r=>r.changed),[true,false]);assert.equal(await store.dailyUsage('today'),1);
 await store.setPending('a',false);await store.selectForCleanup('a',q);assert.equal(await store.dailyUsage('today'),1);
 await store.selectForCleanup('legacy',q);assert.equal(await store.dailyUsage('today'),1);
 await store.selectForCleanup('pro',{...q,charge:false});assert.equal(await store.dailyUsage('today'),1);
 await store.setPending('a',false);await store.selectForCleanup('a',{...q,date:'tomorrow'});
 assert.equal(await store.dailyUsage('tomorrow'),1);assert.equal(await store.dailyUsage('today'),1);
});
test('failed selection rolls back both pending state and daily allowance before retry',async()=>{
 const {store,db,sql}=setup();await store.init();
 sql.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON cleanup_receipt BEGIN SELECT RAISE(ABORT,'disk failure'); END");
 const q={date:'today',charge:true,limit:LIMIT};await assert.rejects(store.selectForCleanup('a',q),/disk failure/);
 assert.equal((await store.trashSummary()).count,0);assert.equal(await store.dailyUsage('today'),0);
 sql.exec('DROP TRIGGER fail_receipt');await store.selectForCleanup('a',q);assert.equal(await store.dailyUsage('today'),1);
});
test('old browsing allowance is retired once, retaining reviews, pending assets and subsequent cleanup counts',async()=>{
 const {store,db}=setup({viewed:['seen'],trash:['pending'],bytes:20,quota:{date:'today',usedToday:30}});
 assert.equal(await store.dailyUsage('today'),0);assert.equal((await store.load()).count,1);assert.deepEqual((await store.load()).trash,['pending']);
 await store.selectForCleanup('new',{date:'today',charge:true,limit:LIMIT});
 const reopened=createReviewStore({open:async()=>db,readLegacy:async()=>{throw Error('not again');}});
 assert.equal(await reopened.dailyUsage('today'),1);assert.equal((await reopened.load()).bytes,20);
});
test('raising the allowance preserves 30 existing selections and permits exactly 70 more',async()=>{
 const {store,db}=setup();const today={date:'today',charge:true,limit:30};
 for(let i=0;i<30;i++)await store.selectForCleanup(`old${i}`,today);
 const reopened=createReviewStore({open:async()=>db,readLegacy:async()=>{throw Error('already migrated');}});
 const raised={...today,limit:LIMIT};
 assert.equal(await reopened.dailyUsage('today'),30);
 const results=await Promise.all(Array.from({length:71},(_,i)=>reopened.selectForCleanup(`new${i}`,raised)));
 assert.equal(results.filter(result=>result.allowed).length,70);
 assert.equal(await reopened.dailyUsage('today'),100);
 await reopened.setPending('old0',false);
 assert.equal((await reopened.selectForCleanup('old0',raised)).allowed,true);
 assert.equal(await reopened.dailyUsage('today'),100);
});


import { createBrowseSession } from '../src/browseSession.mjs';
function browsingFixture(){
 const session=createBrowseSession();
 session.ingest([{items:[{id:'a'}]},{items:[{id:'b'}]}]);session.take(2);session.anchor('a');
 return session;
}
test('browse checkpoints reject stale writes and old sessions after reset',async()=>{
 const {store,db}=setup(),session=browsingFixture();
 const first=session.snapshot();session.anchor('b');const second=session.snapshot();
 assert.equal(await store.saveBrowse(second),true);
 assert.equal(await store.saveBrowse(first),false);
 const reopened=createReviewStore({open:async()=>db,readLegacy:async()=>({})});
 assert.equal((await reopened.loadBrowse()).snapshot.anchorId,'b');
 const epoch=await reopened.resetBrowse();assert.equal(await reopened.saveBrowse(second),false);
 const fresh=createBrowseSession({epoch});assert.equal(await reopened.saveBrowse(fresh.snapshot()),true);
});
test('pending, allowance and the following browse anchor commit or roll back together',async()=>{
 const {store,sql}=setup(),session=browsingFixture();await store.saveBrowse(session.snapshot());
 const policy={date:'today',charge:true,limit:100,checkpoint:()=>session.snapshot({removeId:'a'})};
 sql.exec("CREATE TRIGGER fail_checkpoint BEFORE INSERT ON meta WHEN NEW.key='browse-session' BEGIN SELECT RAISE(ABORT,'checkpoint failure'); END");
 await assert.rejects(store.selectForCleanup('a',policy),/checkpoint failure/);
 assert.equal((await store.trashSummary()).count,0);assert.equal(await store.dailyUsage('today'),0);
 assert.equal((await store.loadBrowse()).snapshot.anchorId,'a');
 sql.exec('DROP TRIGGER fail_checkpoint');await store.selectForCleanup('a',policy);
 assert.equal((await store.loadBrowse()).snapshot.anchorId,'b');
 assert.equal((await store.trashSummary()).count,1);assert.equal(await store.dailyUsage('today'),1);
});
test('quota rejection preserves the same node and does not execute the checkpoint mutation',async()=>{
 const {store}=setup(),session=browsingFixture();await store.saveBrowse(session.snapshot());
 let called=false;
 assert.equal((await store.selectForCleanup('a',{date:'today',charge:true,limit:0,checkpoint:()=>{called=true;return session.snapshot({removeId:'a'});}})).allowed,false);
 assert.equal(called,false);assert.equal((await store.loadBrowse()).snapshot.anchorId,'a');
});
test('corrupt progress can be reset without losing reviews, pending items or daily usage',async()=>{
 const {store,db}=setup();await store.review('kept');await store.selectForCleanup('pending',{date:'today',charge:true,limit:100});
 await db.runAsync("INSERT OR REPLACE INTO meta VALUES ('browse-session',?)",JSON.stringify({version:1,epoch:3,sessionId:'broken',entries:[null],candidates:[]}));
 const saved=await store.loadBrowse();assert.equal(saved.snapshot,null);assert.equal(saved.invalid,true);
 const epoch=await store.resetBrowse();assert.equal(epoch,4);
 assert.equal(await store.saveBrowse(createBrowseSession({epoch}).snapshot()),true);
 assert.equal((await store.load()).count,1);assert.equal(await store.dailyUsage('today'),1);assert.equal((await store.trashSummary()).count,1);
});
