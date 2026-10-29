import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowseSession, isBrowseSnapshot } from '../src/browseSession.mjs';
import { assignBursts, buildBurstUnits } from '../src/burst.js';
import { createCandidatePager } from '../src/candidatePager.mjs';
const photo=(id,time=1000)=>({id,creationTime:time,width:4000,height:3000,mediaType:'photo'});
const single=id=>({items:[photo(id)]});
const burst=id=>({groupSource:'time',items:[photo(id+'a'),photo(id+'b',1200),photo(id+'c',1400)]});
function make(singles=50,bursts=10,random=()=>0.5){
 const session=createBrowseSession({random});
 session.ingest([...Array.from({length:bursts},(_,i)=>burst('g'+i)),...Array.from({length:singles},(_,i)=>single('s'+i))]);
 return session;
}
test('one scheduler spaces groups from the first sample and only exposure confirms progress',()=>{
 const s=make(), sequence=[];
 assert.equal(s.state.rhythm.singles,0);
 const prefetched=s.take(2);assert.deepEqual(prefetched.map(e=>e.unit.items.length),[1,1]);
 assert.equal(s.state.rhythm.singles,0);
 for(const e of prefetched){s.expose(e.unit.items[0].id);sequence.push(e);}
 while(sequence.length<45){const [e]=s.take(1);s.expose(e.unit.items[0].id);sequence.push(e);}
 const indexes=sequence.flatMap((e,i)=>e.unit.items.length>1?[i]:[]);
 assert.equal(indexes[0],2);assert.ok(indexes.length>=7);
 for(let i=1;i<indexes.length;i++)assert.ok(indexes[i]-indexes[i-1]>=4&&indexes[i]-indexes[i-1]<=6);
 const before={...s.state.rhythm};s.expose(sequence[2].unit.items[1].id);
 assert.deepEqual(s.state.rhythm,before);
});
test('relaunch preserves exact group frame, queued order and the next selected interval',()=>{
 const s=make();s.take(2).forEach(e=>s.expose(e.unit.items[0].id));
 const [group]=s.take(1);s.expose(group.unit.items[0].id);s.anchor(group.unit.items[1].id);
 s.take(2);const snapshot=s.snapshot(), resumed=createBrowseSession({snapshot,random:()=>0});
 assert.equal(resumed.state.anchorId,group.unit.items[1].id);
 assert.deepEqual(resumed.state.rhythm,s.state.rhythm);
 assert.deepEqual(resumed.feed().map(e=>e.key),s.feed().map(e=>e.key));
 assert.equal(resumed.expose(group.unit.items[1].id),false);
 assert.deepEqual(resumed.take(2).map(e=>e.unit.items.map(i=>i.id)),s.take(2).map(e=>e.unit.items.map(i=>i.id)));
 const keys=new Set(resumed.state.entries.map(e=>e.key));assert.equal(keys.size,resumed.state.entries.length);
});
test('a late discovered group appears promptly without accumulating back-to-back debt',()=>{
 const s=make(30,0);
 for(let i=0;i<20;i++){const [e]=s.take(1);s.expose(e.unit.items[0].id);}
 assert.equal(s.state.rhythm.singles,5);s.ingest([burst('late1'),burst('late2')]);
 const [first]=s.take(1);assert.equal(first.unit.items.length,3);s.expose(first.unit.items[0].id);
 const next=s.take(3);assert.ok(next.every(e=>e.unit.items.length===1));
});
test('native-only supply degrades unopened presentations without losing or repeating assets',()=>{
 const s=make(0,5), ids=[], kinds=[];
 while(s.hasCandidates){const [e]=s.take(1);assert.ok(e);ids.push(...e.unit.items.map(i=>i.id));kinds.push(e.unit.items.length);s.expose(e.unit.items[0].id);}
 assert.equal(ids.length,15);assert.equal(new Set(ids).size,15);
 const groups=kinds.flatMap((n,i)=>n>1?[i]:[]);
 for(let i=1;i<groups.length;i++)assert.ok(groups[i]-groups[i-1]>=4);
});
test('pending state chooses the following group frame and stable group identity survives the removal',()=>{
 const s=make(3,1);s.take(2);const [e]=s.take(1);s.anchor(e.unit.items[1].id);
 const key=e.key, deleted=e.unit.items[1].id, next=e.unit.items[2].id;
 const checkpoint=s.snapshot({removeId:deleted});assert.equal(checkpoint.anchorId,next);
 assert.equal(s.restoreAnchor(new Set([deleted])),next);
 assert.equal(s.feed(new Set([deleted])).find(x=>x.key===key).unit.items.length,2);
});
test('same-day browsing persists separately, never advances main-stream rhythm, and exits to its anchor',()=>{
 const s=make();const [e]=s.take(1);s.expose(e.unit.items[0].id);
 const main=s.state.anchorId,before={...s.state.rhythm};
 s.enterDay([photo('d1'),photo('d2')],'d2',main);
 assert.equal(s.expose('d2',{source:'day'}),false);
 const r=createBrowseSession({snapshot:s.snapshot()});
 assert.equal(r.state.day.anchorId,'d2');assert.equal(r.state.day.mainId,main);
 assert.deepEqual(r.state.rhythm,before);r.leaveDay();assert.equal(r.state.anchorId,main);
});
test('snapshots contain metadata only and candidate overflow remains owned by its producer',()=>{
 const s=createBrowseSession();
 const items=Array.from({length:600},(_,i)=>({items:[{...photo('p'+i),displayUri:'file:///secret',location:{latitude:1}}]}));
 const overflow=s.ingest(items);assert.equal(s.candidateCount,480);assert.equal(overflow.length,120);
 s.take(2);const snapshot=s.snapshot(), bytes=JSON.stringify(snapshot);
 assert.ok(isBrowseSnapshot(snapshot));assert.ok(!bytes.includes('file:///secret'));assert.ok(!bytes.includes('latitude'));
 assert.ok(bytes.length<512*1024);
});
test('all candidate sources share ID reservation, including duplicates inside a unit',()=>{
 const s=createBrowseSession();
 s.ingest([{items:[photo('a'),photo('a'),photo('b')]}]);s.ingest([single('a'),single('c')]);
 const ids=s.take(4).flatMap(e=>e.unit.items.map(i=>i.id));
 assert.equal(new Set(ids).size,ids.length);assert.deepEqual(new Set(ids),new Set(['a','b','c']));
});
test('cross-page grouping uses complete local context before reviewed members are filtered',async()=>{
 const pages=[[photo('a',5000),photo('b',4000)],[photo('c',3000),photo('d',1000)]];
 let index=0;
 const pager=createCandidatePager({fetchPage:async()=>({assets:pages[index],hasNextPage:++index<2,endCursor:String(index)}),
 eligible:async items=>items.filter(i=>i.id!=='b'),group:items=>{assignBursts(items);return buildBurstUnits(items);},order:u=>u});
 const units=[];while(pager.hasMore)units.push(...await pager.next(1));
 assert.deepEqual(units.map(u=>u.items.map(i=>i.id)),[['d','c','a']]);
});
test('window cropping retains the exposure frontier and never restarts the cadence',()=>{
 const s=make(120,15);let current;
 for(let i=0;i<85;i++){[current]=s.take(1);s.expose(current.unit.items[0].id);}
 s.anchor(current.unit.items[0].id);
 const snap=s.snapshot();assert.ok(snap.entries.length<=48);
 const r=createBrowseSession({snapshot:snap});assert.deepEqual(r.state.rhythm,s.state.rhythm);
 assert.equal(r.expose(current.unit.items[0].id),false);
});
test('quickly skipped unshown singles do not earn another dense group',()=>{
 const s=make();s.take(2).forEach(e=>s.expose(e.unit.items[0].id));
 const [first]=s.take(1);s.expose(first.unit.items[0].id);
 const planned=s.take(6), second=planned.find(e=>e.unit.items.length>1);
 assert.ok(second);assert.equal(s.settle(second.unit.items[0].id),true);
 assert.equal(second.unit.items.length,1);
 s.expose(second.unit.items[0].id);assert.equal(s.state.rhythm.singles,1);
});
test('snapshot excludes in-flight native pagination locks and validates corrupted state safely',()=>{
 const s=make();const [e]=s.take(1);e.loadingMore=true;
 const snapshot=s.snapshot();assert.equal(snapshot.entries[0].loadingMore,undefined);
 const restored=createBrowseSession({snapshot});assert.equal(restored.state.entries[0].loadingMore,undefined);
 assert.equal(isBrowseSnapshot({...snapshot,rhythm:null}),false);
 assert.equal(isBrowseSnapshot({...snapshot,entries:[null]}),false);
});
