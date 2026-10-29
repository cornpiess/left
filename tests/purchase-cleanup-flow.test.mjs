import test from 'node:test';
import assert from 'node:assert/strict';
import { renderComponent, flatten } from './support/render-component.mjs';
const item={id:'photo',width:3000,height:4000,mediaType:'photo'};
function card(prepare) {
 const animations=[];let finalized=0;
 function value() { return {setValue:()=>{},interpolate:()=>0}; }
 const animation=(_v,config)=>({start:callback=>{animations.push(config.toValue);callback?.({finished:true});}});
 const native=new Proxy({__esModule:true,StyleSheet:{create:x=>x},Platform:{OS:'ios'},useWindowDimensions:()=>({width:393,height:852}),Animated:{Value:value,timing:animation,spring:animation,parallel:()=>({start:()=>{}})}},{get:()=>new Proxy(()=>({}),{get:()=>()=>({})})});
 // Proxy must retain the known native implementation.
 const rn=new Proxy(native,{get:(o,k)=>Reflect.has(o,k)?Reflect.getOwnPropertyDescriptor(o,k)?.value:new Proxy(()=>({}),{get:()=>()=>({})})});
 const c=renderComponent('components/MemoryCard.js',{item,items:[item],active:true,preload:false,height:800,onPrepareTrash:prepare,onTrash:asset=>{assert.equal(asset.id,item.id);finalized++;}},{'react-native':rn});
 c.render();const commit=()=>c.slots.find(slot=>slot?.current?.commitTrash)?.current.commitTrash();
 return {commit,animations,get finalized(){return finalized;}};
}
test('quota denial rebounds the actual photo and never runs removal animation',async()=>{
 const e=card(async()=>false);await e.commit();assert.equal(e.finalized,0);assert.deepEqual(e.animations,[0]);
});
test('actual card waits for durable selection, prevents duplicate swipes and removes exactly once',async()=>{
 let resolve,calls=0;const e=card(()=>{calls++;return new Promise(r=>resolve=r);});
 const pending=e.commit();await e.commit();assert.equal(calls,1);assert.equal(e.animations.length,0);assert.equal(e.finalized,0);
 resolve(true);await pending;assert.equal(e.finalized,1);assert.deepEqual(e.animations,[-393]);
});
test('failed durable selection rebounds without losing the actual photo',async()=>{
 const e=card(async()=>{throw Error('disk');});await e.commit();assert.equal(e.finalized,0);assert.deepEqual(e.animations,[0]);
});

test('one purchase surface guards rapid purchase/restore taps and cancellation preserves position',async()=>{
 let resolve,buys=0,restores=0,closed=0;
 const membership={getMembershipState:()=>({isPro:false}),getIapCatalogState:()=>({products:{yearly:{},lifetime:{}},status:'ready'}),IAP_SKUS:{YEARLY:'yearly',LIFETIME:'lifetime'},PRICING_PLANS:{YEARLY:{title:'yearly'},LIFETIME:{title:'lifetime'}},buyIapProduct:()=>{buys++;return new Promise(r=>resolve=r);},restoreIapPurchases:()=>{restores++;return {};}};
 const c=renderComponent('components/PaywallModal.js',{visible:true,reason:'quota',onClose:()=>closed++},{'../membership':membership,'../membershipCore.mjs':{getProductDisplayPrice:(_,fallback)=>fallback}});
 const nodes=flatten(c.render());
 const buy=nodes.find(n=>n.props.onPress&&n.props.disabled!==undefined&&flatten(n).some(child=>child.children.includes('yearly')));
 const restore=nodes.find(n=>n.props.onPress&&n.props.disabled!==undefined&&flatten(n).some(child=>child.children.includes('paywall.restoreBtn')));
 assert.ok(buy);assert.ok(restore);const pending=buy.props.onPress();await buy.props.onPress();await restore.props.onPress();
 assert.equal(buys,1);assert.equal(restores,0);nodes.find(n=>n.props.onRequestClose).props.onRequestClose();assert.equal(closed,0);
 resolve({cancelled:true});await pending;assert.equal(closed,0);
 const success=buy.props.onPress();resolve({success:true});await success;assert.equal(closed,1);
});
