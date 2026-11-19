import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {LocalStore} from '../src/storage.js';
import {GameDatabase,CampaignSessions} from '../src/game-db.js';
import {TavernBridge} from '../src/bridge.js';
import {HostRuntime} from '../src/agents.js';
import {WorldbookProjection} from '../src/worldbook.js';
const tool=(id,name,args)=>({text:'',tools:[{id,function:{name,arguments:JSON.stringify(args)}}]});
const library={list:()=>[],search:async()=>[]};
async function fixture(){const store=new LocalStore('independent-'+crypto.randomUUID(),new IDBFactory()),db=new GameDatabase(store);await db.create('c','b');return{store,db};}
test('no Tavern chat or narration is needed to save, restore, roll and explicitly reroll a completed decision',async()=>{
 const f=await fixture();let turn=0;const runtime=new HostRuntime({...f,library,projection:{sync:async()=>({independent:true})},model:{turn:async()=>++turn%2?tool('roll','reroll_dice',{}):{text:'判定完成',tools:[]}}});
 const options={campaignId:'c',branchId:'b',profile:{model:'qa'},settings:{},messages:[],user:{id:'u1',content:'没有正文，独立投一个D20'}};
 const first=await runtime.execute(options);assert.equal(first.status,'complete');const rolls=await f.store.list('rolls');assert.equal(rolls.length,1);assert.ok(rolls[0].raw[0]>=1&&rolls[0].raw[0]<=20);
 const second=await runtime.execute({...options,user:{id:'u2',content:'直接重roll，不回退状态'}});assert.equal(second.status,'complete');assert.equal((await f.store.list('rolls')).length,2);await runtime.execute({...options,user:{id:'u2',content:'直接重roll，不回退状态'}});assert.equal((await f.store.list('rolls')).length,2);assert.equal((await f.db.get('c','b')).world.revision,0);
});
test('more than forty tool iterations are allowed without an automatic pause',async()=>{
 const f=await fixture();let calls=0;const runtime=new HostRuntime({...f,library,projection:{sync:async()=>({})},model:{turn:async()=>++calls<=45?tool('read-'+calls,'read_state',{}):{text:'工作完成',tools:[]}}});
 const run=await runtime.execute({campaignId:'c',branchId:'b',profile:{model:'qa'},settings:{},messages:[],user:{id:'u',content:'继续处理'}});assert.equal(run.status,'complete');assert.equal(calls,46);
});
test('host state updates do not demand a battle, cooperation, location, narration or proof record',async()=>{
 const f=await fixture();let calls=0;const runtime=new HostRuntime({...f,library,projection:{sync:async()=>({})},model:{turn:async()=>++calls===1?tool('write','execute_actions',{finish_turn:true,operations:[{id:'state',type:'state.update',args:{changes:[{collection:'entities',id:'new',fields:{name:'新角色',kind:'character',location:'现场'}},{collection:'knowledge',id:'k',fields:{value:'主持已确定的情报',subjectId:'new',field:'已知',knowers:['new'],status:'verified',source:'主持决定'}}],nextStop:'继续'}}]}):{text:'完成',tools:[]}}});
 const run=await runtime.execute({campaignId:'c',branchId:'b',profile:{model:'qa'},settings:{},messages:[],user:{id:'u',content:'按我的决定建档并记录情报'}});assert.equal(run.world.entities.new.name,'新角色');assert.equal(run.world.knowledge.k.value,'主持已确定的情报');assert.equal(run.trace.some(t=>t.status==='failed'),false);
});
test('editing old history without a snapshot can continue instead of requiring manual rollback',async()=>{
 const f=await fixture();const fork=await f.db.fork('c','b','no-snapshot');assert.ok(fork.branchId);assert.equal(fork.world.revision,0);
});
test('an independent workspace persists a native backup index without calling chat APIs',async()=>{
 let remote={extension_settings:{lantern_host:{profiles:[]}}},backup;const ctx={chatId:null,characters:[],extensionSettings:{lantern_host:structuredClone(remote.extension_settings.lantern_host)},chatMetadata:{},getRequestHeaders:()=>({}),saveChat:()=>{throw Error('no native chat');}};
 const bridge=new TavernBridge(()=>ctx,async(url,options)=>{if(url==='/api/settings/get')return Response.json({settings:JSON.stringify(remote)});if(url==='/api/settings/save'){remote=JSON.parse(options.body);return Response.json({ok:true});}throw Error('Unexpected chat requirement: '+url);});
 bridge.settingsBase=JSON.stringify(bridge.settings());bridge.writeBackup=async data=>{backup=structuredClone(data);return{path:'qa-backup',sha256:'verified'};};bridge.readBackup=async()=>structuredClone(backup);
 const store=new LocalStore('free-'+crypto.randomUUID(),new IDBFactory()),sessions=new CampaignSessions(bridge,store),key=bridge.key(),loaded=await sessions.load(key);assert.equal(bridge.hasChat(),false);assert.deepEqual(bridge.snapshot(30).messages,[]);loaded.session.draft='独立主持草稿';loaded.session.revision++;await sessions.sync(key,loaded.session);assert.ok(remote.extension_settings.lantern_host.standaloneBinding.backup);
 const restored=new CampaignSessions(bridge,new LocalStore('free-rebuild',new IDBFactory()));assert.equal((await restored.load(key)).session.draft,'独立主持草稿');const projection=new WorldbookProjection(bridge,store,sessions.db),binding=sessions.current(key).binding;assert.equal((await projection.sync(binding.campaignId,binding.branchId,key)).independent,true);
});

test('context estimates and failed automatic compression do not veto a valid model request',async()=>{
 const f=await fixture();let turns=0,compactions=0;const runtime=new HostRuntime({...f,library,projection:{sync:async()=>({})},model:{chat:async()=>{compactions++;throw Error('temporary summary failure');},turn:async()=>++turns<=4?tool('read-'+turns,'read_state',{}):{text:'继续完成',tools:[]}}});
 const run=await runtime.execute({campaignId:'c',branchId:'b',profile:{model:'qa',contextWindow:4096,maxTokens:512},settings:{autoCompact:true},messages:[{role:'user',content:'上下文'.repeat(10000)}],user:{id:'u',content:'继续'}});assert.equal(run.status,'complete');assert.equal(turns,5);assert.ok(compactions>0);assert.ok(run.trace.some(t=>t.kind==='compaction'&&t.status==='failed'));
});
