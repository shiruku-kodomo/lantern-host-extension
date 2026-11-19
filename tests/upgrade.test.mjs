import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {LocalStore} from '../src/storage.js';
import {GameDatabase,emptyWorld} from '../src/game-db.js';
import {migrateRecord,RETIRED_OPERATIONS} from '../src/migrations.js';
import {agentTools,taskWorld,HostRuntime} from '../src/agents.js';
import {DocumentLibrary} from '../src/documents.js';
import {readFile} from 'node:fs/promises';
import {ModelClient} from '../src/provider.js';
import {executeActions} from '../src/actions.js';
import {deliverHandoff} from '../src/handoff.js';
import {WorldbookProjection} from '../src/worldbook.js';
import {TavernBridge} from '../src/bridge.js';
test('old IDB data is physically migrated; restored snapshots and checkpoints cannot revive retired mechanics',async()=>{
  const factory=new IDBFactory(),request=factory.open('lantern-host:old',2);const db=await new Promise(resolve=>{request.onupgradeneeded=()=>{for(const n of ['records','branches','entities','definitions','items','knowledge','quests','rolls','events','plans','runs','turns','snapshots','outbox','bindings','campaigns'])request.result.createObjectStore(n);};request.onsuccess=()=>resolve(request.result);});
  const world={...emptyWorld(),version:1,routes:{r:{}},journeys:{j:{}},quotes:{q:{}},entities:{a:{id:'a',name:'A',wallet:500}},quests:{q:{id:'q',paid:20,reward:100}},definitions:{a:{fields:{wallet:200,basePrice:1,personality:'冷静'}}}};
  await new Promise(resolve=>{const tx=db.transaction(['branches','snapshots','rolls'],'readwrite');tx.objectStore('branches').put({world},'c:b');tx.objectStore('snapshots').put({world,after:world},'c:b:u');tx.objectStore('rolls').put({raw:[17]},'c:b:die');tx.oncomplete=resolve;});db.close();
  const store=new LocalStore('old',factory);await store.ready;const branch=await store.read('branches','c:b');assert.equal(branch.world.entities.a.wallet,undefined);assert.equal(branch.world.routes,undefined);assert.equal(branch.world.definitions.a.fields.personality,'冷静');assert.equal((await store.read('rolls','c:b:die')).raw[0],17);
  const snapshot=await store.read('snapshots','c:b:u');assert.equal(snapshot.after.quotes,undefined);await store.write('branches','restored',{world});assert.equal((await store.read('branches','restored')).world.quests.q.reward,undefined);
  const run=migrateRecord('runs',{status:'running',world,operations:[{id:'paid',type:'currency.transfer'}],conversations:{host:[{role:'assistant',tool_calls:[{id:'pending',function:{name:'mechanism',arguments:JSON.stringify({type:'movement.travel'})}}]}]}});assert.equal(run.operations.length,0);assert.equal(run.cancelledOperations[0].status,'cancelled');assert.ok(run.conversations.host.at(-1).content.includes('cancelled'));
});
test('all agents have batching and scene recording; currency and movement operations are absent',()=>{
  for(const role of ['host','judgment','analysis','intelligence']){const tools=agentTools(role);assert.ok(tools.some(t=>t.function.name==='execute_actions'));const types=tools.find(t=>t.function.name==='mechanism').function.parameters.properties.type.enum;assert.ok(types.includes('scene.update'));for(const type of RETIRED_OPERATIONS)assert.ok(!types.includes(type));}
});
test('batch recovery saves completed operations and reuses them after an interrupted following step',async()=>{
  const run={world:{nextStop:'选择'},operations:[]};let first=0,fail=true,checkpoints=0;
  const engine={execute:async(w,op)=>{if(op.id==='a')first++;if(op.id==='b'&&fail)throw Error('interrupted');return{world:{...w,[op.id]:true},result:{saved:true}};}};
  const args={operations:[{id:'a',type:'scene.update',args:{}},{id:'b',type:'scene.update',args:{}}]};await assert.rejects(executeActions(run,engine,args,async()=>checkpoints++),/interrupted/);fail=false;await executeActions(run,engine,args);assert.equal(first,1);assert.equal(checkpoints,1);assert.equal(run.world.b,true);
});
test('worldbook failure does not block edited handoff; local save, branch and latest reply are checked',async()=>{
  const world=emptyWorld();world.entities.a={id:'a',name:'A'};world.knowledge.k={id:'k',subjectId:'subject',field:'线索',value:'现场事实',status:'observation',knowers:['a'],source:'目击',at:0};
  let saved=false,filled='';const binding={campaignId:'c',branchId:'b'},session={revision:0,handoff:'已编辑内容及玩家原话',handoffSource:{branchId:'b',messageId:'m'},messages:[{id:'m'}]};
  const sessions={current:()=>({binding}),cache:async()=>{saved=true;},db:{get:async()=>({world})}},bridge={key:()=> 'chat',fill:text=>{assert.ok(saved);filled=text;}};
  await deliverHandoff({bridge,sessions,key:'chat',session,mode:'append'});assert.match(filled,/已编辑内容及玩家原话/);assert.match(filled,/现场事实/);session.handoffSource.branchId='other';await assert.rejects(deliverHandoff({bridge,sessions,key:'chat',session}),/分支/);
  session.handoffSource.branchId='b';sessions.cache=async()=>{throw Error('disk full');};filled='';await assert.rejects(deliverHandoff({bridge,sessions,key:'chat',session}),/disk full/);assert.equal(filled,'');
});
test('generated-only knowledge creates a book via native settings list, preserves manual edits and retries failure',async()=>{
 const store=new LocalStore('projection-'+Date.now(),new IDBFactory()),db=new GameDatabase(store);const branch=await db.create('c','b');let bound='',fail=true;const books={};const paths=[];
 const bridge={key:()=> 'chat',context:()=>({chatMetadata:{world_info:bound}}),worldNames:async()=>{paths.push('/api/settings/get');return Object.keys(books);},http:async(p,{name})=>structuredClone(books[name]),saveWorld:async(name,data)=>{if(fail)throw Error('offline');books[name]=structuredClone(data);},bindWorld:async(k,n)=>{bound=n;}};
 const world=branch.world;world.entities.a={id:'a',name:'A'};world.knowledge.k={subjectId:'temporary',field:'观察',value:'事实',knowers:['a'],source:'现场',status:'observation',at:0,canonical:false};await db.commit('c','b',{id:'e',baseRevision:0,world,operations:[],source:{}});
 const projection=new WorldbookProjection(bridge,store,db);await assert.rejects(projection.sync('c','b','chat'),/offline/);assert.ok(await store.read('outbox','world:c:b'));fail=false;const result=await projection.sync('c','b','chat');books[result.name].name='与文件名不同的显示名称';books[result.name].entries.manual={uid:900,content:'手写保留'};await projection.sync('c','b','chat');assert.ok(books[result.name].entries.manual);assert.equal(await store.read('outbox','world:c:b'),undefined);assert.ok(paths.every(p=>p==='/api/settings/get'));
});
test('HTTP errors identify their endpoint and status',async()=>{
 const bridge=new TavernBridge(()=>({getRequestHeaders:()=>({})}),async()=>new Response('',{status:404}));await assert.rejects(bridge.http('/api/worldinfo/edit',{}),e=>e.status===404&&e.message.includes('/api/worldinfo/edit'));
});
test('default task context leaves unrelated archives out but keeps referenced participants and definitions',()=>{
 const w=emptyWorld();w.narrator='a';w.entities={a:{id:'a',name:'A',definitionId:'da'},b:{id:'b',name:'B',definitionId:'db'}};w.definitions={da:{id:'da'},db:{id:'db'}};w.battles.old={id:'old',status:'defeat',allies:['a'],enemies:['b']};const context=taskWorld(w,'A聊天');assert.ok(context.entities.a);assert.equal(context.entities.b,undefined);assert.equal(context.battles.old,undefined);assert.equal(context.availableEntities[0].id,'b');
});
test('a completed batch can hand off real dice without another model call; turn normalization and replay still apply',async()=>{
 const store=new LocalStore('finish-'+Date.now(),new IDBFactory()),db=new GameDatabase(store);await db.create('c','b');const library=await new DocumentLibrary(store,new URL('../content/',import.meta.url),async u=>new Response(await readFile(u))).init();let calls=0;
 const model={turn:async()=>{assert.equal(++calls,1);return{text:'',tools:[{id:'one',function:{name:'execute_actions',arguments:JSON.stringify({finish_turn:true,operations:[{id:'event',type:'random.event',args:{turnId:'model-made-id'}}]})}}]};}};
 const runtime=new HostRuntime({db,store,library,model,projection:{sync:async()=>({})}}),options={campaignId:'c',branchId:'b',user:{id:'actual-turn',content:'触发一次事件并给出事实交接'},profile:{model:'qa'},settings:{},messages:[]};
 const run=await runtime.execute(options);assert.equal(run.status,'complete');assert.match(run.output,/真实骰点/);assert.ok(run.world.claims['random:actual-turn']);assert.equal(run.world.claims['random:model-made-id'],undefined);await runtime.execute(options);assert.equal(calls,1);assert.equal((await store.list('rolls')).length,1);
});
test('a stalled model request times out instead of hanging indefinitely',async()=>{
 const client=new ModelClient({});await assert.rejects(client.deadline({timeoutSeconds:5},{},({signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))),/超过5秒/);
});
test('generated definitions use the actual turn as provenance without searching for nonexistent canonical documents',async()=>{
 const store=new LocalStore('generated-'+Date.now(),new IDBFactory()),db=new GameDatabase(store);await db.create('c','b');const library=await new DocumentLibrary(store,new URL('../content/',import.meta.url),async u=>new Response(await readFile(u))).init();let calls=0;
 const model={turn:async()=>{assert.equal(++calls,1);return{text:'',tools:[{id:'generated',function:{name:'execute_actions',arguments:JSON.stringify({finish_turn:true,operations:[{id:'temporary',type:'definition.create',args:{id:'temporary-clue',type:'other',name:'现场临时线索',origin:'generated',source:{documentId:'not-a-real-document'},fields:{description:'现场发现的临时线索'}}}]})}}]};}};
 const runtime=new HostRuntime({db,store,library,model,projection:{sync:async()=>({})}});await runtime.execute({campaignId:'c',branchId:'b',user:{id:'u',content:'按本轮现场生成临时线索并记录'},profile:{model:'qa'},settings:{},messages:[]});
 const d=(await db.get('c','b')).world.definitions['temporary-clue'];assert.equal(d.source.canonical,false);assert.equal(d.source.quote,'按本轮现场生成临时线索并记录');assert.equal(calls,1);
});
test('an older provider may submit opening sections separately without losing or recreating the valid player archive',async()=>{
 const store=new LocalStore('partial-'+Date.now(),new IDBFactory()),db=new GameDatabase(store);await db.create('c','b');const library=await new DocumentLibrary(store,new URL('../content/',import.meta.url),async u=>new Response(await readFile(u))).init();let calls=0;
 const player={name:'测试玩家',identity:'自由摄影师',acquaintance:'展会相识',basis:'玩家允许主持决定身份',reason:'新生成角色',definition:{fields:{personality:'谨慎',forms:{normal:{hp:100,mp:10,attack:10,defense:10,speed:10}}}}},quests=[1,2,3].map(n=>({name:`调查${n}`,goal:'核实求助',completion:'取得证据',failure:'证人离开',location:'深圳',level:1,hiddenFailure:'证人已经离开'}));
 const model={turn:async()=>{calls++;assert.ok(calls<=2);return{text:'',tools:[{id:'part-'+calls,function:{name:'prepare_opening',arguments:JSON.stringify(calls===1?{player}:{quests})}}]};}};
 const runtime=new HostRuntime({db,store,library,model,projection:{sync:async()=>({})}});const run=await runtime.execute({campaignId:'c',branchId:'b',user:{id:'u',content:'请你扮演月晓菲，决定user扮演的身份并给出三个任务。'},profile:{model:'qa'},settings:{},messages:[]});
 assert.equal(calls,2);assert.equal(run.status,'complete');assert.equal(run.world.opening.completed,true);assert.equal(run.world.entities.player.name,'测试玩家');assert.equal(Object.keys(run.world.quests).length,3);assert.equal(run.trace.filter(t=>t.status==='failed').length,0);assert.equal(run.operations.filter(o=>o.id==='player:definition').length,1);
});
