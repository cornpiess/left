import { DAILY_FREE_LIMIT as LIMIT } from '../src/membershipCore.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createExposureController, createCleanupController } from '../src/experienceCore.mjs';

test('failed or unsettled display never marks history', async () => {
 let writes=0;const c=createExposureController({review:async()=>writes++});
 assert.equal(await c.expose({id:'a'},{ready:false,stable:true}),false);
 assert.equal(await c.expose({id:'b'},{ready:true,stable:false}),false);assert.equal(writes,0);
});
test('browsing remains unlimited after cleanup allowance is exhausted, including burst/day photos',async()=>{
 const ids=new Set();const state={usedToday:LIMIT,isPro:false};
 const c=createExposureController({review:async item=>ids.add(item.id),getMembership:()=>state});
 for(let i=0;i<60;i++)assert.equal(await c.expose({id:`p${i}`},{ready:true,stable:true,source:i%2?'day':'main'}),true);
 assert.equal(ids.size,60);assert.equal(state.usedToday,LIMIT);
});
test('reset invalidates queued display receipts',async()=>{
 let writes=0;const c=createExposureController({review:async()=>writes++});
 const task=c.expose({id:'old'},{ready:true,stable:true});c.reset();assert.equal(await task,false);assert.equal(writes,0);
});
test('cleaning serializes all entry points, applies persisted count and recovers from failure',async()=>{
 const state={date:'today',usedToday:LIMIT-1,isPro:false};let running=0,max=0,fail=true;const policies=[];
 const c=createCleanupController({getMembership:async()=>({...state}),applyUsage:(n,date)=>{assert.equal(date,'today');state.usedToday=n;},select:async(item,p)=>{
  running++;max=Math.max(max,running);policies.push(p);await Promise.resolve();running--;
  if(fail){fail=false;throw Error('disk');}return {allowed:state.usedToday<LIMIT,used:Math.min(LIMIT,state.usedToday+1)};
 }});
 const results=await Promise.allSettled([c.select({id:'a'}),c.select({id:'b'}),c.select({id:'c'})]);
 assert.equal(results[0].status,'rejected');assert.equal(results[1].value.allowed,true);assert.equal(results[2].value.reason,'quota');
 assert.equal(max,1);assert.equal(state.usedToday,LIMIT);assert.ok(policies.every(p=>p.charge&&p.limit===LIMIT));
});
test('Pro and day rollover use current policy at decision time; invalid items never debit',async()=>{
 const state={date:'today',isPro:true};const policies=[];const c=createCleanupController({getMembership:()=>state,select:async(_,p)=>{policies.push(p);return {allowed:true,used:0};}});
 assert.equal((await c.select(null)).reason,'invalid');await c.select({id:'a'});state.isPro=false;state.date='tomorrow';await c.select({id:'b'});
 assert.deepEqual(policies.map(p=>[p.date,p.charge]),[['today',false],['tomorrow',true]]);
});
