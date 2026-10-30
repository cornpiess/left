import test from 'node:test';
import assert from 'node:assert/strict';
import { initialDemo, demoAction } from '../src/onboardingDemo.mjs';
import * as demo from '../src/onboardingDemo.mjs';
import * as gestures from '../src/gestureContract.mjs';
import { renderComponent, flatten } from './support/render-component.mjs';

test('browsing keeps examples; cleanup and undo restore the exact example', () => {
  const first=initialDemo(); const browsed=demoAction(first,'next');
  assert.deepEqual(first,initialDemo()); assert.deepEqual(browsed.pending,[]);
  const selected=demoAction(browsed,'cleanup');
  assert.deepEqual(selected.pending,[1]); assert.equal(selected.current,2);
  const restored=demoAction(selected,'undo');
  assert.equal(restored.current,1); assert.deepEqual(restored.pending,[]);
  assert.equal(demoAction(restored,'undo'),restored);
});
test('example favorite toggles in place and previous returns to retained example',()=>{
  const state=demoAction(initialDemo(),'favorite');assert.equal(state.current,0);assert.deepEqual(state.favorites,[0]);
  assert.deepEqual(demoAction(state,'favorite').favorites,[]);
  assert.equal(demoAction(demoAction(state,'next'),'previous').current,0);
});
test('the actual tutorial accepts swipes and undo without any real library dependencies',()=>{
  const value=function(){this.setValue=()=>{};this.stopAnimation=()=>{};};
  const c=renderComponent('components/OnboardingExperience.js',{}, {
    '../onboardingDemo.mjs':demo,'../gestureContract.mjs':gestures,
    'react-native':{StyleSheet:{create:x=>x,absoluteFillObject:{},hairlineWidth:1},useWindowDimensions:()=>({width:393,height:852}),PanResponder:{create:x=>({panHandlers:x})},Animated:{Value:value,timing:()=>({start:f=>f({finished:true})})}},
  });
  let nodes=flatten(c.render());let card=nodes.find(x=>x.props.onPanResponderRelease);
  card.props.onPanResponderGrant();card.props.onPanResponderRelease(null,{dx:-90,dy:1});
  nodes=flatten(c.render());assert.ok(nodes.some(n=>n.children.includes('onboarding.safe')));
  const undo=nodes.find(n=>n.props.onPress&&n.children.some(x=>x?.children?.includes('onboarding.undo')));
  assert.equal(undo.props.disabled,false);undo.props.onPress();
  nodes=flatten(c.render());assert.equal(nodes.find(n=>n.props.onPress&&n.children.some(x=>x?.children?.includes('onboarding.undo'))).props.disabled,true);
});
