import test from 'node:test';
import assert from 'node:assert/strict';
import * as timeline from '../src/onboardingMotion.mjs';
import { renderComponent, flatten } from './support/render-component.mjs';

function at(name, ms) {
  const { inputRange:x, outputRange:y }=timeline.motionConfig(name,400);
  const time=ms/timeline.ONBOARDING_CYCLE_MS;
  let i=0;while(i<x.length-2&&x[i+1]<time)i++;
  const ratio=Math.max(0,Math.min(1,(time-x[i])/(x[i+1]-x[i])));
  return parseFloat(y[i])+(parseFloat(y[i+1])-parseFloat(y[i]))*ratio;
}
test('the viewer gets a neutral pause, then a decision, left tilt, departure and receipt in order',()=>{
  assert.equal(at('selectedY',2200),0);
  assert.equal(at('decisionLabel',2200),0);
  assert.equal(at('neutralLabel',2200),1);
  assert.equal(at('selectedX',2200),0);
  assert.equal(at('selectedAngle',2200),0);
  assert.equal(at('decisionLabel',3200),1);
  assert.ok(at('selectedAngle',3500)<0);
  assert.equal(at('selectedX',3500),0);
  assert.equal(at('receipt',4100),0);
  assert.ok(at('selectedX',4300)<=-400);
  assert.equal(at('selectedOpacity',4300),0);
  assert.ok(at('receipt',4600)>0);
  assert.equal(at('nextY',4800),0);
  assert.equal(at('nextOpacity',4800),1);
});
test('every track has a continuous loop boundary and strictly ordered native keyframes',()=>{
  for(const name of ['firstY','firstOpacity','selectedX','selectedY','selectedAngle','selectedOpacity','neutralLabel','decisionLabel','leftArrow','nextY','nextOpacity','receipt']){
    const config=timeline.motionConfig(name);
    assert.equal(config.outputRange[0],config.outputRange.at(-1),name);
    for(let i=1;i<config.inputRange.length;i++)assert.ok(config.inputRange[i]>config.inputRange[i-1],name);
  }
});
function setup({motion=false,reject=false}={}){
 const events={};let active=0;const props={paused:false};
 const value=function(){this.setValue=()=>{};this.stopAnimation=()=>{};this.interpolate=x=>x;};
 const add=(name,fn)=>{events[name]=fn;return {remove:()=>delete events[name]};};
 const c=renderComponent('components/OnboardingMotion.js',props,{
  '../onboardingMotion.mjs':timeline,
  'react-native':{
   StyleSheet:{create:x=>x,absoluteFillObject:{}},View:'View',Text:'Text',Easing:{linear:x=>x},useWindowDimensions:()=>({width:393,height:852}),
   AccessibilityInfo:{isReduceMotionEnabled:()=>reject?Promise.reject(Error('unavailable')):Promise.resolve(motion),addEventListener:(_,fn)=>add('motion',fn)},
   AppState:{currentState:'active',addEventListener:(_,fn)=>add('app',fn)},
   Animated:{View:'AnimatedView',Text:'AnimatedText',Value:value,timing:()=>({}),loop:()=>{let running=false;return {start:()=>{if(!running){running=true;active++;}},stop:()=>{if(running){running=false;active--;}}};}},
  },
 },{effects:true});
 const render=()=>{const tree=c.render();c.flushEffects();return tree;};
 return {c,events,props,render,get active(){return active;}};
}
test('actual motion pauses for access prompts/background/Reduce Motion, resumes once and cleans up',async()=>{
 const e=setup();e.render();assert.equal(e.active,0);await Promise.resolve();e.render();assert.equal(e.active,1);
 e.props.paused=true;e.render();assert.equal(e.active,0);
 e.props.paused=false;e.render();assert.equal(e.active,1);
 e.events.app('background');e.render();assert.equal(e.active,0);
 e.events.app('active');e.render();assert.equal(e.active,1);
 e.events.motion(true);e.render();assert.equal(e.active,0);
 e.events.motion(false);const tree=e.render();assert.equal(e.active,1);
 assert.ok(flatten(tree).every(n=>!n.props.onPress&&!n.props.onTouchStart&&!n.props.onPanResponderRelease));
 e.c.unmount();assert.equal(e.active,0);assert.deepEqual(Object.keys(e.events),[]);
});
test('motion preference failures keep a static meaningful illustration without blocking access',async()=>{
 const e=setup({reject:true});e.render();await Promise.resolve();await Promise.resolve();const tree=e.render();
 assert.equal(e.active,0);assert.equal(tree.props.accessibilityLabel,'onboarding.motionLabel');e.c.unmount();
});
