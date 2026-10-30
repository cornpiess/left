import test from 'node:test';
import assert from 'node:assert/strict';
import { createCandidatePager } from '../src/candidatePager.mjs';
const unit=items=>items.map(item=>({items:[item]}));
test('pages are loaded only on demand, boundaries and overflow preserve every asset',async()=>{
 let fetched=0;const pages=[['a','b','c'],['d','e'],['f']];
 const pager=createCandidatePager({fetchPage:async()=>{const i=fetched++;return {assets:pages[i].map((id,j)=>({id,creationTime:100-i*10-j})),hasNextPage:i<2,endCursor:String(i+1)};},eligible:async a=>a,group:unit,order:a=>a});
 assert.equal(fetched,0);const ids=[];
 while(pager.hasMore) {const batch=await pager.next(1);ids.push(...batch.flatMap(u=>u.items.map(i=>i.id)));assert.ok(batch.length<=1);}
 assert.deepEqual(ids,['a','b','c','d','e','f']);assert.equal(fetched,3);
});
test('skips fully reviewed pages without completing prematurely or dropping overflow',async()=>{
 let i=0;const pager=createCandidatePager({fetchPage:async()=>({assets:[{id:String(++i),creationTime:5-i}],endCursor:String(i),hasNextPage:i<4}),eligible:async a=>a.filter(x=>Number(x.id)>2),group:unit,order:a=>a});
 const ids=[];while(pager.hasMore)ids.push(...(await pager.next(1)).flatMap(u=>u.items.map(x=>x.id)));
 assert.deepEqual(ids,['3','4']);assert.equal(pager.scanned,4);
});
test('non-advancing native cursor is an error, not a fake completion',async()=>{
 const pager=createCandidatePager({fetchPage:async()=>({assets:[],hasNextPage:true,endCursor:'same'}),eligible:async a=>a,group:unit,order:a=>a});
 await assert.rejects(pager.next(1),/did not advance/);
});
