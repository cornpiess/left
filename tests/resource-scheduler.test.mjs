import test from 'node:test';
import assert from 'node:assert/strict';
import { createResourceScheduler } from '../src/resourceScheduler.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('native IO concurrency is capped, identical requests share work, priorities advance current work',async()=>{
 const s=createResourceScheduler({concurrency:1});const order=[];let finish;
 const running=s.run('running',0,()=>new Promise(r=>{finish=r;}));await tick();
 const bg=s.run('bg',2,async()=>order.push('bg'));const current=s.run('current',0,async()=>order.push('current'));
 assert.equal(s.run('bg',2,()=>{throw Error('duplicate');}),bg);finish();await Promise.all([running,current,bg]);assert.deepEqual(order,['current','bg']);
});
test('interaction defers background tasks; cancellation does not leave pending promises',async()=>{
 const s=createResourceScheduler();s.setInteractive(true);let ran=false;
 const bg=s.run('stale',2,async()=>{ran=true;});await tick();assert.equal(ran,false);s.cancelQueued(k=>k==='stale');assert.equal(await bg,null);
 const current=s.run('current',0,async()=>42);assert.equal(await current,42);
 const visible=s.run('visible-neighbour',1,async()=>3);assert.equal(await visible,3);
 const next=s.run('bg',2,async()=>4);await tick();assert.equal(s.pending,1);s.setInteractive(false);assert.equal(await next,4);
});

test('background work reserves a slot for foreground and queued duplicates can be promoted',async()=>{
 const s=createResourceScheduler({concurrency:3});let release1,release2;let ran=false;
 const one=s.run('b1',2,()=>new Promise(r=>release1=r)),two=s.run('b2',2,()=>new Promise(r=>release2=r));await tick();
 const bg=s.run('b3',2,async()=>{ran=true;});await tick();assert.equal(ran,false);
 assert.equal(await s.run('visible',0,async()=>7),7);
 release1();release2();await Promise.all([one,two,bg]);
 s.setInteractive(true);const delayed=s.run('next-photo',2,async()=>8);await tick();
 assert.equal(s.run('next-photo',0,()=>{throw Error('must share');}),delayed);assert.equal(await delayed,8);
});
