import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {IDBFactory} from 'fake-indexeddb';
import {LocalStore} from '../src/storage.js';
import {GameDatabase,emptyWorld} from '../src/game-db.js';
import {ContentRegistry} from '../src/rules.js';
import {MechanismEngine} from '../src/mechanisms.js';
import {DocumentLibrary} from '../src/documents.js';
import {HostRuntime,agentTools,validatePlan} from '../src/agents.js';
import {AGENT_PROMPTS} from '../src/agent-prompts.js';
import {normalizeSettings,requestMessages,emptySession} from '../src/core.js';
import {executeCombatBlock} from '../src/actions.js';
import {completedTurnSummary} from '../src/results.js';
import {migrateRecord} from '../src/migrations.js';
import {fraction as F} from '../src/exact.js';
async function fixture(){const store=new LocalStore('judgment-'+crypto.randomUUID(),new IDBFactory()),db=new GameDatabase(store);await db.create('c','b');const library=await new DocumentLibrary(store,new URL('../content/',import.meta.url),async u=>new Response(await readFile(u))).init();return{store,db,library,engine:new MechanismEngine({db,campaignId:'c',branchId:'b',registry:new ContentRegistry(library),runId:'r'})};}
const entity=id=>({id,name:id,kind:'character',definitionId:id,form:'normal',forms:{normal:{hp:100,mp:20,attack:20,defense:20,speed:20}},hp:F(100),mp:F(20),training:0,defeats:0,skills:[]});
test('the four current agents have no character delegation or action narration schema; custom prompts survive',()=>{
 assert.deepEqual(Object.keys(AGENT_PROMPTS),['host','judgment','analysis','intelligence']);assert.throws(()=>agentTools('character'),/已移除/);
 const tools=agentTools('host'),delegate=tools.find(t=>t.function.name==='delegate').function.parameters,combat=tools.find(t=>t.function.name==='execute_combat_block').function.parameters;
 assert.deepEqual(delegate.properties.role.enum,['judgment','analysis','intelligence']);assert.equal(delegate.properties.characterId,undefined);assert.equal(combat.properties.rounds,undefined);assert.ok(combat.properties.roundOverrides);assert.ok(!combat.required.includes('rounds'));
 const settings=normalizeSettings({agentPromptVersion:2,agentPrompts:{host:'我的主持规则',character:'旧角色规则'}});assert.equal(settings.agentPrompts.host,'我的主持规则');assert.equal(settings.agentPrompts.character,undefined);
});
test('a five-round block needs no narrated actions and allows a single mechanical override; replay does not reroll',async()=>{
 const f=await fixture(),w=emptyWorld();w.entities.A=entity('A');w.entities.E=entity('E');const run={id:'r',userId:'u',world:w,operations:[],operationResults:{}};
 const args={id:'battle',allies:['A'],enemies:['E'],majorEnemyId:'E',basis:'已发生遭遇',roundOverrides:[{round:2,defenseField:'speed'}]};
 const result=await executeCombatBlock(run,f.engine,args);assert.equal(result.rounds.length,5);assert.equal((await f.store.list('rolls')).length,10);assert.ok(result.rounds.every(r=>r.action==='战斗对抗'));
 const before=JSON.stringify(run.world);await executeCombatBlock(run,f.engine,args);assert.equal((await f.store.list('rolls')).length,10);assert.equal(JSON.stringify(run.world),before);
 const summary=completedTurnSummary(run);assert.match(summary,/我方骰点→总值/);assert.equal(summary.includes('战斗对抗'),false);
});
test('a repeated mandatory defeat settlement reuses its receipt instead of rejecting or applying a second loss',async()=>{
 const f=await fixture(),w=emptyWorld();w.entities.A={...entity('A'),formalDefeat:true,defeatCause:'battle:test'};
 const first=await f.engine.execute(w,{id:'first',type:'growth.defeat',args:{entityId:'A'}}),second=await f.engine.execute(first.world,{id:'model-repeat',type:'growth.defeat',args:{entityId:'A'}});assert.equal(second.result.reused,true);assert.equal(second.world.entities.A.defeats,1);assert.deepEqual(second.world.entities.A.forms,first.world.entities.A.forms);assert.equal(second.result.sourceEventId,'battle:test');
});
test('narrative task location is optional and falls back to the current scene',async()=>{
 const f=await fixture(),w=emptyWorld();w.scene='当前街区';const result=await f.engine.execute(w,{id:'q',type:'quest.create',args:{id:'q',goal:'调查线索',completion:'核实线索',failure:'目标不再可达',level:1}});assert.equal(result.world.quests.q.location,'当前街区');assert.equal(result.world.quests.q.name,'调查线索');
});
test('invalid duplicate round overrides fail before the first real die',async()=>{
 const f=await fixture(),w=emptyWorld();w.entities.A=entity('A');w.entities.E=entity('E');await assert.rejects(executeCombatBlock({world:w,operations:[]},f.engine,{id:'b',allies:['A'],enemies:['E'],majorEnemyId:'E',basis:'test',roundOverrides:[{round:2},{round:2}]}),/不重复/);assert.equal((await f.store.list('rolls')).length,0);
});
test('pending old character plans migrate to the host while executed historical records remain intact',()=>{
 const plan={goal:'处理后果',status:'pending',steps:[{id:'one',agent:'character',task:'根据结果处理任务阶段',dependencies:[],tools:['read_state']}]};validatePlan(plan);assert.equal(plan.steps[0].agent,'host');
 const old={...structuredClone(plan),steps:[{...plan.steps[0],agent:'character'}]},pending=migrateRecord('plans',old);assert.equal(pending.steps[0].agent,'host');const history={...old,status:'executed',steps:[{...old.steps[0],agent:'character'}]};assert.equal(migrateRecord('plans',history).steps[0].agent,'character');
});
test('a pending legacy character delegate resumes under the host with its old receipt and dice',async()=>{
 const f=await fixture(),w=(await f.db.get('c','b')).world,die=await f.db.roll('c','b','old-die',{sides:20},()=>({raw:[17],total:17}));
 const call={id:'legacy',function:{name:'delegate',arguments:JSON.stringify({role:'character',characterId:'A',task:'处理旧任务'})}},key='host:legacy';
 const run={id:'b:u',campaignId:'c',branchId:'b',userId:'u',input:'继续旧任务',status:'running',baseRevision:0,before:structuredClone(w),world:w,operations:[],operationResults:{},receipts:{[key+':die']:die},conversations:{host:[{role:'system',content:'旧主持'},{role:'assistant',tool_calls:[call]}],[key]:[{role:'system',content:'你是角色Agent。'},{role:'user',content:'旧任务'},{role:'assistant',tool_calls:[{id:'die',function:{name:'roll_dice',arguments:JSON.stringify({id:'old-die',sides:20})}}]},{role:'tool',tool_call_id:'die',content:JSON.stringify(die)}]},trace:[],results:[]};await f.store.write('runs','c:b:b:u',run);
 let calls=0;const model={turn:async(profile,messages)=>{calls++;assert.ok(!messages[0].content.includes('你是角色Agent'));return{text:'任务后果已承接，等待下一选择。',tools:[]};}};
 const runtime=new HostRuntime({...f,model,projection:{sync:async()=>({})}});const done=await runtime.execute({campaignId:'c',branchId:'b',user:{id:'u',content:'继续旧任务'},profile:{model:'qa'},settings:{},messages:[]});assert.equal(done.status,'complete');assert.equal(calls,2);assert.equal((await f.store.list('rolls')).length,1);
});
test('selected narration is actual story context and can be recorded without demanding extra provenance',async()=>{
 const f=await fixture(),w=(await f.db.get('c','b')).world;w.entities.A=entity('A');await f.db.commit('c','b',{id:'seed',baseRevision:0,world:w,operations:[],source:{}});
 const messages=requestMessages({settings:normalizeSettings(),session:emptySession(),context:{messages:[{role:'assistant',content:'店主告诉A：仓库今晚停电。'}]}});assert.match(messages[1].content,/已发生剧情/);assert.ok(!messages[1].content.includes('只作为参考'));
 const runtime=new HostRuntime({...f,model:{turn:async()=>({text:'',tools:[{id:'k',function:{name:'execute_actions',arguments:JSON.stringify({finish_turn:true,operations:[{id:'known',type:'knowledge.record',args:{id:'known',subjectId:'warehouse',field:'停电时间',value:'今晚',status:'rumor',knowers:['A']}}]})}}]})},projection:{sync:async()=>({})}});
 const done=await runtime.execute({campaignId:'c',branchId:'b',user:{id:'u',content:'承接店主刚才的话'},profile:{model:'qa'},settings:{},messages});assert.equal(done.world.knowledge.known.source,'当前选中正文与本轮玩家输入');assert.deepEqual(done.world.entities.A.hp,F(100));assert.equal(done.trace.filter(t=>t.status==='failed').length,0);
});
