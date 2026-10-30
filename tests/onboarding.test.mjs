import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderComponent, flatten } from './support/render-component.mjs';
function setup(request) {
 let completed=0,lastPermission;
 const c=renderComponent('screens/OnboardingScreen.js',{onComplete:p=>{completed++;lastPermission=p;}},{'expo-media-library/legacy':{requestPermissionsAsync:request}});
 const start=()=>flatten(c.render()).find(x=>x.props.accessibilityLabel==='onboarding.startBtn');
 return {c,start,get completed(){return completed;},get lastPermission(){return lastPermission;}};
}
test('one value screen requests access once and goes directly to real photos after grant',async()=>{
 let resolve,calls=0;const permission={granted:true,accessPrivileges:'limited'};
 const e=setup(()=>{calls++;return new Promise(r=>resolve=r);});
 const button=e.start();const first=button.props.onPress();await button.props.onPress();assert.equal(calls,1);assert.equal(e.completed,0);
 resolve(permission);await first;assert.equal(e.completed,1);assert.equal(e.lastPermission,permission);
});
test('permission denial stays on the single screen with settings and an escape',async()=>{
 const e=setup(async()=>({granted:false}));await e.start().props.onPress();assert.equal(e.completed,0);
 const nodes=flatten(e.c.render());assert.ok(nodes.some(n=>n.props.accessibilityLabel==='onboarding.privacySettingsBtn'));
 const skip=nodes.find(n=>n.props.onPress&&n.children.some(c=>c?.children?.includes('onboarding.privacyNotNow')));
 assert.ok(skip);skip.props.onPress();assert.equal(e.completed,1);
});
test('permission error hands off to the existing retry gate without forcing a tutorial',async()=>{
 const e=setup(async()=>{throw Error('unavailable');});await e.start().props.onPress();assert.equal(e.completed,1);
 const screen=await readFile(new URL('../src/screens/OnboardingScreen.js',import.meta.url),'utf8');
 assert.doesNotMatch(screen,/PanResponder|SwipeDemoPage|demoDone|setPage/);
});
test('all cleaning gestures and day-button use the shared decision, never a feed lock',async()=>{
 const home=await readFile(new URL('../src/screens/HomeScreen.js',import.meta.url),'utf8');
 const day=await readFile(new URL('../src/components/DayMemoryCarousel.js',import.meta.url),'utf8');
 assert.doesNotMatch(home,/canAccess|lockedAt|markForTrash\(/);
 assert.equal((home.match(/onPrepareTrash=\{prepareTrash\}/g)||[]).length,2);
 assert.match(day,/await onPrepareTrash\?\.\(item\)/);
 assert.match(day,/onPrepareTrash=\{prepareDayTrash\}/);
});
