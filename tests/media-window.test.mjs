import test from 'node:test';
import assert from 'node:assert/strict';
import { photoCardSize, planPhotoWindow, mergeDayWindow } from '../src/mediaWindow.mjs';
import { createDayPager } from '../src/dayPager.mjs';
import { renderComponent, flatten } from './support/render-component.mjs';

test('preheat uses actual proportional card geometry and a bounded two-item window',()=>{
 const items=[{id:'portrait',width:3000,height:4000},{id:'landscape',width:4000,height:3000},{id:'third'}];
 const plan=planPhotoWindow(items,381,800);
 assert.equal(plan.length,2);assert.deepEqual(plan[0],{id:'portrait',width:381,height:508});
 assert.deepEqual(plan[1],{id:'landscape',width:381,height:286});
 assert.deepEqual(photoCardSize(null,381,800),{width:381,height:508});
});
function setup(count=10000){
 const start=new Date(2026,9,28).getTime();
 const assets=Array.from({length:count},(_,i)=>({id:`p${i}`,creationTime:start+1000+i}));
 const calls=[];const anchor=assets[Math.floor(count/2)];
 const fetchPage=async o=>{
  calls.push(o);const pool=assets.filter(a=>a.creationTime>o.createdAfter&&a.creationTime<o.createdBefore).sort((a,b)=>o.ascending?a.creationTime-b.creationTime:b.creationTime-a.creationTime);
  const offset=Number(o.after||0),part=pool.slice(offset,offset+o.first);
  return {assets:part,hasNextPage:offset+part.length<pool.length,endCursor:String(offset+part.length)};
 };
 return {assets,anchor,calls,pager:createDayPager({anchor,fetchPage})};
}
test('a 10,000-photo day opens around the anchor with two bounded queries, and no duplicate anchor',async()=>{
 const e=setup();const before=await e.pager.next('before'),after=await e.pager.next('after');
 assert.equal(e.calls.length,2);assert.ok(e.calls.every(o=>o.first===80));
 assert.equal(before.length,79);assert.equal(after.length,79);assert.ok(before.every(a=>a.creationTime<e.anchor.creationTime));assert.ok(after.every(a=>a.creationTime>e.anchor.creationTime));
});
test('day pages do not skip items at cursor boundaries and reject a stuck native cursor',async()=>{
 const e=setup(500);const ids=new Set([e.anchor.id]);
 for(const side of ['before','after'])while(e.pager.more(side)){for(const item of await e.pager.next(side)){assert.ok(!ids.has(item.id));ids.add(item.id);}}
 assert.equal(ids.size,500);
 const bad=createDayPager({anchor:e.anchor,fetchPage:async()=>({assets:[],hasNextPage:true,endCursor:'stuck'})});
 await assert.rejects(bad.next('before'),/did not advance/);
});
test('day window stays bounded and discarded earlier photos can be fetched again',async()=>{
 const e=setup(2000);let items=[...(await e.pager.next('before')),e.anchor,...(await e.pager.next('after'))];
 for(let i=0;i<4;i++){
  const page=await e.pager.next('after');const merged=mergeDayWindow(items,page,'after');
  if(merged.resetSide){e.pager.forget(merged.dropped.map(x=>x.id));e.pager.reset('before',merged.items[0]);}
  items=merged.items;assert.ok(items.length<=320);
 }
 const back=await e.pager.next('before');assert.ok(back.length>0);assert.ok(back.every(x=>x.creationTime<items[0].creationTime));
});
test('same-timestamp photos remain reachable from both directions',async()=>{
 const anchor={id:'a',creationTime:Date.now()};const same=Array.from({length:200},(_,i)=>({id:`t${i}`,creationTime:anchor.creationTime}));
 const pager=createDayPager({anchor,fetchPage:async o=>{const start=Number(o.after||0);return {assets:same.slice(start,start+80),hasNextPage:start+80<200,endCursor:String(start+80)};}});
 const ids=new Set();while(pager.more('after'))(await pager.next('after')).forEach(x=>ids.add(x.id));
 assert.equal(ids.size,200);
});
test('the actual video card stays mounted through scrolling, while only the active card plays',()=>{
 const props={item:{id:'v',width:1920,height:1080,mediaType:'video',displayUri:'ph://v'},items:[],height:800,active:true,retainPlayer:true,preload:true};
 const c=renderComponent('components/MemoryCard.js',props);
 const video=()=>flatten(c.render()).find(node=>node.type?.name==='MemoryVideo');
 assert.equal(video().props.playing,true);
 props.active=false;assert.equal(video().props.playing,false);
 props.retainPlayer=false;props.videoPreload=true;assert.ok(video());
 props.constrained=true;assert.equal(video(),undefined);
 props.constrained=false;props.videoPreload=false;assert.equal(video(),undefined);
});

test('day paging advances past pages containing only pending-deletion assets',async()=>{
 const anchor={id:'a',creationTime:Date.now()};let calls=0;
 const p=createDayPager({anchor,eligible:item=>item.id==='keep',fetchPage:async o=>{
  calls++;return o.after?{assets:[{id:'keep',creationTime:anchor.creationTime+2}],hasNextPage:false,endCursor:'done'}:{assets:[{id:'pending',creationTime:anchor.creationTime+1}],hasNextPage:true,endCursor:'next'};
 }});
 assert.deepEqual((await p.next('after')).map(item=>item.id),['keep']);assert.equal(calls,2);
});

