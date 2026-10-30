import test from 'node:test';
import assert from 'node:assert/strict';
import { assignBursts, buildBurstUnits, filterEligibleBurstUnit } from '../src/burst.js';

function photo(id, creationTime, extra = {}) {
  return { id, creationTime, mediaType: 'photo', width: 4032, height: 3024, mediaSubtypes: [], ...extra };
}

test('does not classify photo sequences taken far apart as bursts', () => {
  const assets = [photo('a', 0), photo('b', 10000), photo('c', 20000)];
  assignBursts(assets);
  assert.deepEqual(buildBurstUnits(assets).map((unit) => unit.items.map((item) => item.id)), [['a'], ['b'], ['c']]);
});

test('groups rapid sequences including live photos into burst decks', () => {
  const assets = [
    photo('a', 1000),
    photo('b', 1500),
    photo('c', 2000),
    photo('live', 2400, { mediaSubtypes: ['livePhoto'] }),
  ];
  assignBursts(assets);
  assert.deepEqual(buildBurstUnits(assets).map((unit) => unit.items.map((item) => item.id)), [['a', 'b', 'c', 'live']]);
});

test('keeps unviewed frames eligible when another frame in the burst was viewed', () => {
  const unit = { items: [photo('a', 1), photo('b', 2), photo('c', 3)] };
  const eligible = filterEligibleBurstUnit(unit, {
    viewedIds: new Set(['a']),
    attemptedIds: new Set(),
    trashIds: new Set(),
  });
  assert.deepEqual(eligible.items.map((item) => item.id), ['b', 'c']);
});

test('released unseen burst frames stay as later cards instead of regrouping behind the viewed anchor', () => {
  const frame = (id, creationTime) => ({ id, creationTime, mediaType: 'photo', width: 4000, height: 3000 });
  const anchor = frame('a', 1_000);
  const laterCard = frame('d', 30_000);
  const unseen1 = { ...frame('b', 1_200), suppressBurstRegroup: true };
  const unseen2 = { ...frame('c', 1_400), suppressBurstRegroup: true };
  const replayOrder = [anchor, laterCard, unseen1, unseen2];

  assignBursts(replayOrder);
  const units = buildBurstUnits(replayOrder);

  assert.deepEqual(units.map((unit) => unit.items.map((item) => item.id)), [['a'], ['d'], ['b'], ['c']]);
});

test('screenshots remain standalone and time proximity alone is conservative',()=>{
 const assets=[photo('a',1000,{mediaSubtypes:['screenshot']}),photo('b',1200,{mediaSubtypes:['screenshot']}),photo('c',2000),photo('d',4001)];
 assignBursts(assets);assert.deepEqual(buildBurstUnits(assets).map(u=>u.items.map(x=>x.id)),[['a'],['b'],['c'],['d']]);
});
test('different system burst identities never merge even at adjacent timestamps',()=>{
 const assets=[photo('a',1000,{nativeBurstId:'one'}),photo('b',1400,{nativeBurstId:'one'}),photo('c',1500,{nativeBurstId:'two'}),photo('d',1900,{nativeBurstId:'two'})];
 assignBursts(assets);assert.deepEqual(buildBurstUnits(assets).map(u=>u.items.map(x=>x.id)),[['a','b'],['c','d']]);
});


test('manual captures use a 2-second gap, a 15-second total window, and deterministic ties',()=>{
 const captures=[photo('b',1000),photo('a',1000),photo('c',3000)];
 assignBursts(captures);assert.deepEqual(buildBurstUnits(captures).map(u=>u.items.map(i=>i.id)),[['a','b','c']]);
 const long=Array.from({length:10},(_,i)=>photo(String(i),1000+i*2000));
 assignBursts(long);assert.deepEqual(buildBurstUnits(long).map(u=>u.items.length),[8,2]);
});
test('system identity overrides ordinary time and geometry thresholds',()=>{
 const items=[photo('a',1000,{nativeBurstId:'x'}),photo('b',61000,{nativeBurstId:'x',width:3024,height:4032}),
 photo('c',120000,{nativeBurstId:'y'}),photo('d',121000,{nativeBurstId:'y'})];
 assignBursts(items);assert.deepEqual(buildBurstUnits(items).map(u=>u.items.map(i=>i.id)),[['a','b'],['c','d']]);
});
test('missing metadata and intervening media never join unrelated ordinary shots',()=>{
 for(const extra of [{creationTime:undefined},{creationTime:NaN},{width:0},{height:undefined}]){
  const items=[photo('a',1000,extra),photo('b',1200,extra)];
  assignBursts(items);assert.ok(buildBurstUnits(items).every(u=>u.items.length===1));
 }
 for(const boundary of [photo('v',1100,{mediaType:'video'}),photo('s',1100,{mediaSubtypes:['screenshot']})]){
  const items=[photo('a',1000),boundary,photo('b',1200)];
  assignBursts(items);assert.ok(buildBurstUnits(items).every(u=>u.items.length===1));
 }
});
