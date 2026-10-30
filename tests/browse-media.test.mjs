import test from 'node:test';
import assert from 'node:assert/strict';
import {runtime, photo} from './support/media-runtime.mjs';
test('production candidate pipeline preserves groups and first-sample scheduling through SQLite relaunch',async()=>{
 const assets=[...Array.from({length:4},(_,i)=>photo('s'+i,100000+i*10000)),
 photo('a',200000),photo('b',201000),photo('c',202000),photo('tail',300000)];
 const r=runtime(assets),m=r.media;
 await m.openBrowseSession();
 const first=await m.fetchMemoryPage();assert.equal(first.units.length,2);assert.ok(first.units.every(e=>e.unit.items.length===1));
 const session=m.getBrowseSession();for(const e of first.units){session.anchor(e.unit.items[0].id);session.expose(e.unit.items[0].id);await m.markAssetViewed(e.unit.items[0]);}
 const next=await m.fetchMemoryPage(50,'next'),group=next.units[0];
 assert.deepEqual([...group.unit.items.map(i=>i.id)],['a','b','c']);
 session.expose('a');session.anchor('b');await m.markAssetViewed(group.unit.items[1]);await m.persistBrowseSession();
 const fresh=runtime(assets,r.store);const restored=await fresh.media.openBrowseSession();
 assert.equal(restored.state.anchorId,'b');assert.equal(fresh.queries(),0);
 assert.ok(restored.feed().some(e=>e.unit.items.some(i=>i.id==='b')),'already reviewed anchor must survive resumption');
 assert.equal(restored.state.rhythm.hasBurst,true);
});
test('production cleanup and cold start agree on the next group frame without charging again',async()=>{
 const r=runtime([photo('s1',10000),photo('s2',20000),photo('a',30000),photo('b',31000),photo('c',32000)]);
 const m=r.media;await m.openBrowseSession();const initial=await m.fetchMemoryPage();
 for(const e of initial.units)m.getBrowseSession().expose(e.unit.items[0].id);
 const next=await m.fetchMemoryPage(50,'next'),group=next.units.find(e=>e.unit.items.length>1);
 const target=group.unit.items[1];m.getBrowseSession().anchor(target.id);await m.persistBrowseSession();
 assert.equal((await m.selectForCleanup(target,{date:'today',charge:true,limit:100})).allowed,true);
 const fresh=runtime([photo('s1',10000),photo('s2',20000),photo('a',30000),photo('b',31000),photo('c',32000)],r.store);
 const restored=await fresh.media.openBrowseSession();assert.equal(restored.state.anchorId,'c');
 assert.equal(await r.store.dailyUsage('today'),1);
});
test('system burst members are expanded by identity even when only its representative is sampled',async()=>{
 const members=Array.from({length:12},(_,i)=>photo('n'+i,100000+i*10000));
 const r=runtime([photo('s1',10000),photo('s2',20000),members[0]],undefined,{nativeBursts:{native:members}});
 await r.media.openBrowseSession();const first=await r.media.fetchMemoryPage();
 for(const e of first.units)r.media.getBrowseSession().expose(e.unit.items[0].id);
 const next=await r.media.fetchMemoryPage(50,'next'),group=next.units.find(e=>e.unit.nativeId==='native');
 assert.ok(group);assert.equal(group.unit.items.length,12);assert.equal(group.unit.nativeCount,12);
});
test('unseen native continuation survives leaving its group and restarting the app',async()=>{
 const members=Array.from({length:350},(_,i)=>photo('n'+i,100000+i*10000));
 const assets=[photo('s1',10000),photo('s2',20000),members[0],photo('end',9999999)];
 const r=runtime(assets,undefined,{nativeBursts:{native:members}}),m=r.media;
 await m.openBrowseSession();const first=await m.fetchMemoryPage();
 for(const e of first.units){m.getBrowseSession().expose(e.unit.items[0].id);await m.markAssetViewed(e.unit.items[0]);}
 const page=await m.fetchMemoryPage(50,'next'),group=page.units.find(e=>e.unit.nativeId==='native');
 assert.equal(group.unit.items.length,160);
 m.getBrowseSession().anchor('n1');await m.markAssetViewed(group.unit.items[1]);
 const released=m.releaseUnviewedBurstFrames(group.unit.items,'n1');
 m.getBrowseSession().reconcile(m.getBrowseSession().state.entries.flatMap(e=>e.unit.items).filter(i=>!released.has(i.id)));
 await m.persistBrowseSession();
 const cold=runtime(assets,r.store,{nativeBursts:{native:members}});
 const restored=await cold.media.openBrowseSession();
 assert.ok(restored.state.continuations.length);assert.ok(restored.state.deferred.length);
 const ids=new Set(restored.state.entries.flatMap(e=>e.unit.items.map(i=>i.id)));
 for(let page=0;page<250;page++){
  const result=await cold.media.fetchMemoryPage(50,'next');
  for(const e of result.units)for(const item of e.unit.items){
   assert.ok(!ids.has(item.id),'asset repeated '+item.id);ids.add(item.id);
   restored.anchor(item.id);restored.expose(item.id);await cold.media.markAssetViewed(item);
  }
  // Use the same bounded history reconciliation as HomeScreen.
  if(restored.state.entries.length>60)restored.reconcile(restored.state.entries.slice(-40).flatMap(e=>e.unit.items));
  if(!result.hasNextPage)break;
 }
 for(const member of members)assert.ok(ids.has(member.id),'missing native member '+member.id);
});
test('same-day cold launch preserves its active ID and the main return anchor',async()=>{
 const assets=[photo('s1',10000),photo('s2',20000),photo('d1',30000),photo('d2',40000)];
 const r=runtime(assets),m=r.media;await m.openBrowseSession();await m.fetchMemoryPage();
 m.getBrowseSession().anchor('d2'); // absent in committed window must not replace the main anchor
 const main=m.getBrowseSession().state.anchorId;
 m.getBrowseSession().enterDay([assets[2],assets[3]],'d2',main);await m.markAssetViewed(assets[3]);await m.persistBrowseSession();
 const cold=runtime(assets,r.store),session=await cold.media.openBrowseSession();
 assert.equal(session.state.day.anchorId,'d2');assert.equal(session.state.day.mainId,main);assert.equal(cold.queries(),0);
});

test('an old candidate request cannot overwrite the session created by a history reset',async()=>{
 let release,started,wait=true;
 const gate=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{started=resolve;});
 const assets=Array.from({length:8},(_,i)=>photo('p'+i,10000+i*10000));
 const r=runtime(assets,undefined,{beforeQuery:async()=>{if(wait){wait=false;started();await gate;}}});
 await r.media.openBrowseSession();const pending=r.media.fetchMemoryPage();await entered;
 const fresh=await r.media.resetBrowseSession();release();
 assert.equal((await pending).stale,true);
 const next=await r.media.fetchMemoryPage();
 assert.equal(r.media.getBrowseSession().state.epoch,fresh.state.epoch);
 assert.equal(next.units.length,2);
 assert.equal((await r.store.loadBrowse()).snapshot.sessionId,r.media.getBrowseSession().state.sessionId);
});
test('an externally deleted current photo resumes at its successor, not the start of the cached window',async()=>{
 const assets=Array.from({length:10},(_,i)=>photo('p'+i,10000+i*10000));
 const r=runtime(assets),m=r.media;await m.openBrowseSession();
 for(let i=0;i<3;i++)await m.fetchMemoryPage(50,'next');
 const session=m.getBrowseSession(),ordered=session.state.entries.flatMap(e=>e.unit.items),target=ordered[3],successor=ordered[4];
 session.anchor(target.id);await m.persistBrowseSession();
 const cold=runtime(assets.filter(a=>a.id!==target.id),r.store);
 assert.equal((await cold.media.openBrowseSession()).state.anchorId,successor.id);
});
