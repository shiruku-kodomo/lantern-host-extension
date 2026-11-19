import {TavernBridge} from '../src/bridge.js';
import {WorldbookProjection} from '../src/worldbook.js';
export async function nativeFixture(store,db,campaignId){
  const origin=process.env.QA_TAVERN_URL||'http://127.0.0.1:8001';if(new URL(origin).port!=='8001')throw new Error('Native fixtures are restricted to the isolated QA Tavern on port 8001.');
  const response=await fetch(origin+'/csrf-token'),cookies=response.headers.getSetCookie().map(c=>c.split(';')[0]).join('; '),{token}=await response.json();
  const headers=()=>({'Content-Type':'application/json',Cookie:cookies,'X-CSRF-Token':token}),id=`Lantern-v036-${Date.now()}-${crypto.randomUUID()}`;
  const context={groupId:id,chatId:id,chatMetadata:{},extensionSettings:{},getRequestHeaders:headers};
  const bridge=new TavernBridge(()=>context,(url,options)=>fetch(new URL(url,origin),options));
  context.saveChat=()=>bridge.http('/api/chats/group/save',{id,chat:[{chat_metadata:context.chatMetadata},{name:'QA',is_user:false,mes:'isolated regression fixture'}],force:true});
  // Files and chat binding are real HTTP. Frontend cache/injection are tested separately in phase2-browser.
  const cache=new Map();bridge.worldModule=async()=>({worldInfoCache:cache,updateWorldInfoList:()=>bridge.worldNames(),loadWorldInfo:async name=>{const data=await bridge.http('/api/worldinfo/get',{name});cache.set(name,data);return data;}});
  await context.saveChat();const baseline=`${id}-initial`;await bridge.saveWorld(baseline,{entries:{0:{uid:0,comment:'QA original',content:'QA original manual entry',constant:false}}});await bridge.bindWorld(bridge.key(),baseline);
  const projection=new WorldbookProjection(bridge,store,db);await projection.ensureInitial(campaignId,bridge.key());return{bridge,projection,chatId:id};
}
