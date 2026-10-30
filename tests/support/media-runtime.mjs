import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { createReviewStore, RecentIds } from '../../src/reviewStore.mjs';
import * as browse from '../../src/browseSession.mjs';
import * as burst from '../../src/burst.js';
import * as config from '../../src/algorithmConfig.mjs';
import * as sampling from '../../src/sampling.mjs';
import * as utils from '../../src/asyncUtils.mjs';
import * as pages from '../../src/mediaPage.mjs';
import { createTrashDeletion } from '../../src/trashDeletion.mjs';
import { createCandidatePager } from '../../src/candidatePager.mjs';
import { createDayPager } from '../../src/dayPager.mjs';
import { createResourceScheduler } from '../../src/resourceScheduler.mjs';
const require=createRequire(import.meta.url),babel=require('@babel/core');
const compiled=babel.transformSync(readFileSync(new URL('../../src/media.js',import.meta.url),'utf8'),
 {configFile:false,babelrc:false,plugins:[require.resolve('@babel/plugin-transform-modules-commonjs')]}).code;
export const photo=(id,time,extra={})=>({id,creationTime:time,width:4000,height:3000,mediaType:'photo',...extra});
export function databaseAdapter(){
 const sql=new DatabaseSync(':memory:');
 const db={execAsync:async q=>sql.exec(q),runAsync:async(q,...v)=>sql.prepare(q).run(...v),
 getFirstAsync:async(q,...v)=>sql.prepare(q).get(...v),getAllAsync:async(q,...v)=>sql.prepare(q).all(...v)};
 db.withExclusiveTransactionAsync=async fn=>{sql.exec('BEGIN IMMEDIATE');try{const r=await fn(db);sql.exec('COMMIT');return r;}catch(e){sql.exec('ROLLBACK');throw e;}};
 return db;
}
export function database(){return createReviewStore({open:async()=>databaseAdapter(),readLegacy:async()=>({})});}
export function fileStore(files={}){
 const db=databaseAdapter(),exports={};
 const code=babel.transformSync(readFileSync(new URL('../../src/reviewStore.js',import.meta.url),'utf8'),
  {configFile:false,babelrc:false,plugins:[require.resolve('@babel/plugin-transform-modules-commonjs')]}).code;
 const fs={documentDirectory:'file:///documents/',getInfoAsync:async path=>({exists:path in files}),readAsStringAsync:async path=>files[path]};
 vm.runInNewContext(code,{exports,require:id=>id==='expo-file-system/legacy'?fs:id==='expo-sqlite'?{openDatabaseAsync:async()=>db}
  :id==='./reviewStore.mjs'?{createReviewStore}:(()=>{throw Error('unmocked store '+id);})(),console});
 return exports.reviewStore;
}
export function runtime(assets,store=database(),{nativeBursts={},beforeQuery,nativeModule,query,permission=()=>({granted:true,accessPrivileges:"all"})}={}){
 let queries=0,accessible=0;const events=[];
 const all=()=>assets;
 const library={SortBy:{creationTime:'creationTime'},MediaType:{photo:'photo',video:'video'},
 getPermissionsAsync:async()=>permission(),
 getAssetsAsync:async o=>{
  await beforeQuery?.(o); queries++;const intercepted=await query?.(o,queries);if(intercepted)return intercepted;let pool=all().filter(a=>(o.createdAfter==null||a.creationTime>o.createdAfter)&&(o.createdBefore==null||a.creationTime<o.createdBefore));
  pool.sort((a,b)=>o.sortBy?.[0]?.[1]?a.creationTime-b.creationTime:b.creationTime-a.creationTime);
  const n=Number(o.after||0),part=pool.slice(n,n+o.first);
  return {assets:part,hasNextPage:n+part.length<pool.length,endCursor:String(n+part.length)};
 },
 getAssetInfoAsync:async id=>all().find(a=>a.id===id)||null};
 const modules={
 'react-native':{Platform:{OS:'ios'},AppState:{addEventListener:()=>({remove(){}})}},
 'expo-media-library/legacy':library,'expo-media-library/next':{Asset:function(){}},
 'expo-file-system/legacy':{},'expo-network':{getNetworkStateAsync:async()=>({isConnected:true,isInternetReachable:true})},
 '@react-native-async-storage/async-storage':{getItem:async()=>null,setItem:async()=>{}},
 './burst':burst,'./algorithmConfig.mjs':config,'./sampling.mjs':sampling,'./picker':{shuffle:a=>a.slice()},
 './asyncUtils.mjs':utils,'./trashDeletion.mjs':{createTrashDeletion},
 './reviewStore':{reviewStore:store},'./reviewStore.js':{reviewStore:store},'./reviewStore.mjs':{RecentIds},'./browseSession.mjs':browse,
 './candidatePager.mjs':{createCandidatePager},'./dayPager.mjs':{createDayPager},
 './resourceScheduler.mjs':{createResourceScheduler},'./mediaPage.mjs':pages,'./flightRecorder':{flightEvent:(...e)=>events.push(e)},
 './nativePhotoPreview':null,

 };
 const native={getBurstIdentifiers:async ids=>Object.fromEntries(ids.map(id=>[id,Object.entries(nativeBursts).find(([,v])=>v.some(a=>a.id===id))?.[0]||null])),
 getAccessibleAssetIds:async ids=>{accessible+=ids.length;return ids.filter(id=>all().some(a=>a.id===id)||Object.values(nativeBursts).some(v=>v.some(a=>a.id===id)));},
 getBurstMembers:async(id,offset=0)=>{
  const full=nativeBursts[id]||[],items=full.slice(offset,offset+160).map(a=>({...a,nativeBurstId:id,nativeBurstCount:full.length}));
  return {items,count:full.length,nextOffset:Math.min(full.length,offset+160)};
 },deleteAssets:async()=>true};
 const nativeExports={};
 const nativeCode=babel.transformSync(readFileSync(new URL('../../src/nativePhotoPreview.js',import.meta.url),'utf8'),
 {configFile:false,babelrc:false,plugins:[require.resolve('@babel/plugin-transform-modules-commonjs')]}).code;
 vm.runInNewContext(nativeCode,{exports:nativeExports,require:id=>id==='react-native'?modules[id]:id==='expo-modules-core'
  ?{requireOptionalNativeModule:()=>nativeModule===undefined?native:nativeModule,requireNativeViewManager:()=>function(){}}
  :id==='./flightRecorder'?modules[id]:(()=>{throw Error('unmocked native '+id);})(),console});
 modules['./nativePhotoPreview']=nativeExports;
 const exports={};
 vm.runInNewContext(compiled,{exports,require:id=>{if(!(id in modules))throw Error('unmocked '+id);return modules[id];},
 console:{...console,log(){}},Date,Math,Set,Map,Promise,setTimeout,clearTimeout,URL});
 return {media:exports,store,events,queries:()=>queries,accessible:()=>accessible};
}
