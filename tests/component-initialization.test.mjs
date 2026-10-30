import * as gestureContract from '../src/gestureContract.mjs';
import * as mediaWindow from '../src/mediaWindow.mjs';
import { DAILY_FREE_LIMIT } from '../src/membershipCore.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require=createRequire(import.meta.url);
const babel=require('@babel/core');
function renderSource(source,props){
 const universal=new Proxy(function(){return universal},{get:(_,k)=>k==='then'?undefined:universal,construct:()=>universal});
 const react={__esModule:true,memo:f=>f,useState:init=>[typeof init==='function'?init():init,()=>{}],useRef:v=>({current:v}),useEffect:()=>{},useMemo:fn=>fn(),useCallback:fn=>fn,createElement:(type,props,...children)=>({type,props,children})};react.default=react;
 const mock={
  'react':react,
  'react-native':new Proxy({__esModule:true,StyleSheet:{create:x=>x},Animated:{Value:function(){return universal}},Platform:{OS:'ios'},useWindowDimensions:()=>({width:393,height:852})},{get:(o,k)=>k in o?o[k]:universal}),
  'react-native-safe-area-context':{useSafeAreaInsets:()=>({top:30,bottom:20})},
  '@react-navigation/native':{useIsFocused:()=>true},
  '../i18n':{useI18n:()=>({t:x=>x})},
  '../membership':{getMembershipState:()=>({isPro:false,usedToday:0,date:'today'}),DAILY_FREE_LIMIT},
  '../experience':{experience:{canAccess:()=>true}},
  '../nativePhotoPreview':{supportsNativePhotoPreview:false},
  '../mediaWindow.mjs':mediaWindow,
  '../gestureContract.mjs':gestureContract,
  '../media':new Proxy({isVideoAsset:item=>item?.mediaType==='video',isItemFavorite:()=>false},{get:(o,k)=>k in o?o[k]:universal}),
 };
 const code=babel.transformSync(source,{configFile:false,babelrc:false,plugins:[require.resolve('@babel/plugin-transform-react-jsx'),require.resolve('@babel/plugin-transform-modules-commonjs')]}).code;
 const exports={};const context={React:react,exports,require:id=>mock[id]||new Proxy({__esModule:true},{get:(o,k)=>k in o?o[k]:universal}),console,Set,Map,Math,Date,Promise,setTimeout,clearTimeout,__DEV__:false};
 vm.runInNewContext(code,context);
 return exports.default(props);
}
for(const [file,props] of [['screens/HomeScreen.js',{accessPrivileges:'all'}],['components/MemoryCard.js',{item:{id:'a',width:3000,height:4000,mediaType:'photo'},items:[],active:false,preload:false,height:800}]]){
 test(`${file} initializes hooks without referencing later declarations`,async()=>{
  const source=await readFile(new URL('../src/'+file,import.meta.url),'utf8');
  assert.ok(renderSource(source,props));
 });
}
