import * as gestureContract from '../../src/gestureContract.mjs';
import * as mediaWindow from '../../src/mediaWindow.mjs';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { loadBurstMotionRuntime, loadMotionRuntime } from './motion-runtime.mjs';
const require=createRequire(import.meta.url),babel=require('@babel/core');
export function renderComponent(file, props={}, overrides={}, options={}) {
 const universal=new Proxy(function(){return universal},{get:(_,k)=>k==='then'?undefined:universal,construct:()=>universal});
 const slots=[];let cursor=0;
 const effects=new Map(), pendingEffects=[];
 const effect=(fn,deps)=>{const i=cursor++;if(!options.effects)return;const prev=effects.get(i);if(prev&&deps&&deps.length===prev.deps?.length&&deps.every((v,n)=>Object.is(v,prev.deps[n])))return;const record={deps,cleanup:null};effects.set(i,record);pendingEffects.push(()=>{prev?.cleanup?.();record.cleanup=fn();});};
 const react={__esModule:true,memo:f=>f,useState:init=>{const i=cursor++;if(!(i in slots))slots[i]=typeof init==='function'?init():init;return [slots[i],v=>{slots[i]=typeof v==='function'?v(slots[i]):v;}];},useRef:v=>{const i=cursor++;return slots[i]|| (slots[i]={current:v});},useEffect:effect,useMemo:fn=>fn(),useCallback:fn=>fn,createElement:(type,props,...children)=>({type,props:props||{},children})};react.default=react;
 react.useLayoutEffect=react.useEffect;
 const modules={
  react,
  'react-native':new Proxy({__esModule:true,StyleSheet:{create:x=>x},Animated:{Value:function(){return universal}},Platform:{OS:'ios'},useWindowDimensions:()=>({width:393,height:852})},{get:(o,k)=>k in o?o[k]:universal}),
  'react-native-safe-area-context':{useSafeAreaInsets:()=>({top:30,bottom:20})},
  '@react-navigation/native':{useIsFocused:()=>true},
  '../i18n':{useI18n:()=>({t:x=>x})},
  '../membership':{getMembershipState:()=>({isPro:false,usedToday:0,date:'today'}),getIapCatalogState:()=>({products:{yearly:{},lifetime:{}},status:'ready'}),IAP_SKUS:{YEARLY:'yearly',LIFETIME:'lifetime'},PRICING_PLANS:{YEARLY:{title:'yearly'},LIFETIME:{title:'lifetime'}}},
  '../experience':{experience:{}},
  '../nativePhotoPreview':{supportsNativePhotoPreview:false},
  '../mediaWindow.mjs':mediaWindow,
  '../gestureContract.mjs':gestureContract,
  '../media':new Proxy({isVideoAsset:item=>item?.mediaType==='video',isItemFavorite:()=>false},{get:(o,k)=>k in o?o[k]:universal}),
  ...overrides,
 };
 modules['../motion'] ??= loadMotionRuntime(modules['react-native']);
 modules['./motion'] ??= modules['../motion'];
 if(file==='components/MemoryCard.js')modules['../useBurstMotion'] ??= loadBurstMotionRuntime(modules['react-native'],react,modules['../motion']);
 const source=readFileSync(new URL('../../src/'+file,import.meta.url),'utf8');
 const code=babel.transformSync(source,{configFile:false,babelrc:false,plugins:[require.resolve('@babel/plugin-transform-react-jsx'),require.resolve('@babel/plugin-transform-modules-commonjs')]}).code;
 const exports={};vm.runInNewContext(code,{React:react,exports,require:id=>modules[id]||new Proxy({__esModule:true},{get:(o,k)=>k in o?o[k]:universal}),console,Set,Map,Math,Date,Promise,setTimeout,clearTimeout,__DEV__:false});
 return {slots,render:()=>{cursor=0;return exports.default(props);},flushEffects:()=>{while(pendingEffects.length)pendingEffects.shift()();},unmount:()=>{effects.forEach(record=>record.cleanup?.());effects.clear();}};
}
export function flatten(tree) {
 if(Array.isArray(tree))return tree.flatMap(flatten);
 if(!tree||typeof tree!=='object')return [];
 return [tree,...(tree.children||[]).flatMap(flatten)];
}
