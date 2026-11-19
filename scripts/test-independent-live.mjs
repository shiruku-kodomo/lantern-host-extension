import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {LocalStore} from '../src/storage.js';
import {GameDatabase} from '../src/game-db.js';
import {HostRuntime} from '../src/agents.js';
import {ModelClient} from '../src/provider.js';
import {TavernBridge} from '../src/bridge.js';
import {WorldbookProjection} from '../src/worldbook.js';
import {DocumentLibrary} from '../src/documents.js';
import {normalizeSettings} from '../src/core.js';
const saved=normalizeSettings(JSON.parse(await readFile(process.argv[2],'utf8')).extension_settings.lantern_host),profile=saved.profiles.find(p=>p.id===saved.activeProfileId);
assert.ok(profile,'missing real profile');
const origin='http://127.0.0.1:8000',response=await fetch(origin+'/csrf-token'),cookies=response.headers.getSetCookie().map(c=>c.split(';')[0]).join('; '),{token}=await response.json();
const context={chatId:null,characterId:null,groupId:null,chat:[],chatMetadata:{},characters:[],extensionSettings:{lantern_host:{}}},headers=()=>({'Content-Type':'application/json',Cookie:cookies,'X-CSRF-Token':token});context.getRequestHeaders=headers;
const bridge=new TavernBridge(()=>context,(url,options)=>fetch(new URL(url,origin),options));bridge.account='isolated-live-qa';
const store=new LocalStore('independent-live-'+Date.now(),new IDBFactory()),db=new GameDatabase(store),campaign='qa-'+Date.now(),branch='main';await db.create(campaign,branch);
const library=await new DocumentLibrary(store,new URL('../content/',import.meta.url),async url=>new Response(await readFile(url))).init();
const client=new ModelClient(bridge,(url,options)=>fetch(new URL(url,origin),options));let requests=0;
const model={turn:(...args)=>{requests++;return client.turn(...args);},chat:(...args)=>client.chat(...args)},projection=new WorldbookProjection(bridge,store,db),runtime=new HostRuntime({store,db,model,library,projection});runtime.chatKey=bridge.key();
const results=[];let prior;
for(let round=1;round<=2;round++){
 const modifier=round===1?2:4,input=round===1?'这是独立主持真实测试，没有酒馆聊天和正文。直接投一次真实1D20，修正+2，大于等于12成功。不要查询资料或建角色。判定后用state.update把definitions.qa-check保存为{name:"独立判定记录",type:"record",fields:{raw,modifier,total,outcome}}，写入实际点数和判定。':'现在主动重roll刚才的检定，改成修正+4，仍是1D20且大于等于12成功。无正文也直接重新判定，不回退状态，不继续旧请求。通过reroll_dice产生新骰子，然后state.update覆盖definitions.qa-check的实际raw、modifier、total、outcome。';
 const started=Date.now(),before=requests;
 const run=await runtime.execute({campaignId:campaign,branchId:branch,user:{id:'turn-'+round,content:input,...(prior?{rerollContext:{previousInput:prior.input,previousOutput:prior.output,checks:(await store.list('rolls'))}}:{})},profile,settings:normalizeSettings({}),messages:[]});
 const rolls=await store.list('rolls'),current=await db.get(campaign,branch);assert.equal(run.status,'complete');assert.equal(rolls.length,round);assert.equal(rolls.at(-1).modifierTotal,modifier);assert.equal(current.world.definitions['qa-check'].fields.total,rolls.at(-1).total);assert.ok(!run.worldbookError,run.worldbookError);
 const result={round,model:profile.model,requests:requests-before,elapsedMs:Date.now()-started,independent:!bridge.hasChat(),status:run.status,branch,revision:current.world.revision,raw:rolls.at(-1).raw,modifier:rolls.at(-1).modifierTotal,total:rolls.at(-1).total,record:current.world.definitions['qa-check'].fields,output:run.output};results.push(result);console.log(JSON.stringify(result));prior=run;
}
await writeFile(new URL('../test-results/independent-live-v039.json',import.meta.url),JSON.stringify({results},null,2));
