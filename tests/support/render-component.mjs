import * as gestureContract from '../../src/gestureContract.mjs';
import * as mediaWindow from '../../src/mediaWindow.mjs';
import * as promotions from '../../src/promotions.mjs';
import * as feedbackPolicy from '../../src/feedbackPolicy.mjs';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { loadBurstMotionRuntime, loadMotionRuntime } from './motion-runtime.mjs';
const require=createRequire(import.meta.url),babel=require('@babel/core');
export function renderComponent(file, props={}, overrides={}, options={}) {
 const universal=new Proxy(function(){return universal},{get:(_,k)=>k==='then'?undefined:universal,construct:()=>universal});
 const slots=[];let cursor=0,memoCursor=0;const memoSlots=[];
 const memoize=(factory,deps)=>{const i=memoCursor++;const previous=memoSlots[i];if(previous&&deps&&deps.length===previous.deps?.length&&deps.every((v,n)=>Object.is(v,previous.deps[n])))return previous.value;const value=factory();memoSlots[i]={value,deps};return value;};
 const effects=new Map(), pendingEffects=[];
 const effect=(fn,deps)=>{const i=cursor++;if(!options.effects)return;const prev=effects.get(i);if(prev&&deps&&deps.length===prev.deps?.length&&deps.every((v,n)=>Object.is(v,prev.deps[n])))return;const record={deps,cleanup:null};effects.set(i,record);pendingEffects.push(()=>{prev?.cleanup?.();record.cleanup=fn();});};
 const react={__esModule:true,memo:f=>f,useState:init=>{const i=cursor++;if(!(i in slots))slots[i]=typeof init==='function'?init():init;return [slots[i],v=>{slots[i]=typeof v==='function'?v(slots[i]):v;}];},useRef:v=>{const i=cursor++;return slots[i]|| (slots[i]={current:v});},useEffect:effect,useMemo:fn=>fn(),useCallback:fn=>fn,createElement:(type,props,...children)=>({type,props:props||{},children})};react.default=react;
 react.useLayoutEffect=react.useEffect;
 if(options.memoized){react.useMemo=memoize;react.useCallback=(fn,deps)=>memoize(()=>fn,deps);}
 const sharedFeedback = { __esModule: true };
 for (const name of ['default', 'BusyMark', 'FeedbackAction']) {
  const tag = function SharedFeedback() {};
  tag.testRender = props => renderComponent('components/Feedback.js', props, overrides, { exportName: name }).render();
  sharedFeedback[name] = tag;
 }
 const modules={
  react,
  './Feedback': sharedFeedback, '../components/Feedback': sharedFeedback,
  'react-native':new Proxy({__esModule:true,StyleSheet:{create:x=>x},Animated:{Value:function(){return universal}},Platform:{OS:'ios'},useWindowDimensions:()=>({width:393,height:852})},{get:(o,k)=>k in o?o[k]:universal}),
  'react-native-safe-area-context':{useSafeAreaInsets:()=>({top:30,bottom:20})},
  '@react-navigation/native':{useIsFocused:()=>true},
  '../i18n':{useI18n:()=>({t:x=>x})},
  '../membership':{getMembershipState:()=>({isPro:false,usedToday:0,date:'today'}),getIapCatalogState:()=>({products:{yearly:{},lifetime:{}},status:'ready'}),IAP_SKUS:{YEARLY:'yearly',LIFETIME:'lifetime'},PRICING_PLANS:{YEARLY:{title:'yearly'},LIFETIME:{title:'lifetime'}}},
  '../experience':{experience:{}},
  '../nativePhotoPreview':{supportsNativePhotoPreview:false},
  '../mediaWindow.mjs':mediaWindow, '../feedbackPolicy.mjs':feedbackPolicy,
  '../promotions.mjs':promotions,
  '../gestureContract.mjs':gestureContract,
  '../media':new Proxy({isVideoAsset:item=>item?.mediaType==='video',isItemFavorite:()=>false},{get:(o,k)=>k in o?o[k]:universal}),
  ...overrides,
 };
 modules['../motion'] ??= loadMotionRuntime(modules['react-native']);
 modules['./motion'] ??= modules['../motion'];
 if(file==='components/MemoryCard.js')modules['../useBurstMotion'] ??= loadBurstMotionRuntime(modules['react-native'],react,modules['../motion']);
 const source=readFileSync(new URL('../../src/'+file,import.meta.url),'utf8');
 const code=babel.transformSync(source,{configFile:false,babelrc:false,plugins:[require.resolve('@babel/plugin-transform-react-jsx'),require.resolve('@babel/plugin-transform-modules-commonjs')]}).code;
 const exports={};vm.runInNewContext(code,{React:react,exports,require:id=>modules[id]||new Proxy({__esModule:true},{get:(o,k)=>k in o?o[k]:universal}),console,Set,Map,Math,Date:options.clock?.Date||Date,Promise,setTimeout:options.clock?.setTimeout||setTimeout,clearTimeout:options.clock?.clearTimeout||clearTimeout,__DEV__:false});
 return {slots,render:()=>{cursor=0;memoCursor=0;return exports[options.exportName||'default'](props);},flushEffects:()=>{while(pendingEffects.length)pendingEffects.shift()();},unmount:()=>{effects.forEach(record=>record.cleanup?.());effects.clear();}};
}
export function flatten(tree) {
 if(Array.isArray(tree))return tree.flatMap(flatten);
 if(!tree||typeof tree!=='object')return [];
 if(tree.type && Object.hasOwn(tree.type,'testRender'))return [tree,...flatten(tree.type.testRender({...tree.props,children:tree.children}))];
 if(typeof tree.type==='function' && ['FeedbackAction','BusyMark'].includes(tree.type.name))return [tree,...flatten(tree.type(tree.props))];
 return [tree,...(tree.children||[]).flatMap(flatten)];
}

// Normal gesture tests start after an actual display receipt. Tests for the
// loading/error guard deliberately omit this helper.
export function displayMedia(component) {
 const nodes=flatten(component.render());
 const video=nodes.find(node=>typeof node.props?.onFirstFrame==='function');
 const image=nodes.find(node=>typeof node.props?.onLoad==='function' && typeof node.props?.onError==='function');
 if(video)video.props.onFirstFrame();
 else if(image)image.props.onLoad();
 return component.render();
}
