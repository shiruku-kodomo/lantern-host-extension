import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {LocalStore} from '../src/storage.js';
import {GameDatabase,branchKey,CampaignSessions} from '../src/game-db.js';
import {HostRuntime} from '../src/agents.js';
import {ModelClient} from '../src/provider.js';
const doc={id:'doc',title:'正式角色',path:'3.游戏内容/1.参与角色/A.md',sha256:'source-v1',content:'name: A\nage: 25\n未变身：[HP:100/100][MP:40/40][Atk:25][Armor:5][Speed:15]\n变身后：[HP:300/300][MP:80/80][Atk:180][Armor:6][Speed:40]'};
const library={read:async()=>doc,list:()=>[doc],search:async()=>[doc]};
const call=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
const tool=(id,name,args)=>({text:'',summary:'',usage:null,tools:[call(id,name,args)]});
const text=value=>({text:value,summary:'',usage:{prompt_tokens:100},tools:[]});
async function fixture(sequence,extra=[]){const store=new LocalStore('runtime',new IDBFactory());await store.ready;const db=new GameDatabase(store);await db.create('campaign','branch');const calls=[];const model={turn:async(profile,messages,options)=>{calls.push(structuredClone(messages));const next=sequence.shift();if(next instanceof Error)throw next;assert.ok(next,'unexpected model invocation');return next;}};const entries=[doc,...extra],registryLibrary={...library,read:async id=>entries.find(item=>item.id===id)||doc,list:()=>[...entries,...Object.values((awaitRules))]};return{store,db,calls,runtime:new HostRuntime({store,db,model,library:registryLibrary,projection:{sync:async()=>({revision:1})}})};}
// Mechanism source documents are supplied to the registry, not to a pretend dice implementation.
import {RULES} from '../src/rules.js';
const awaitRules=Object.fromEntries(Object.values(RULES).map(r=>[r.id,{...doc,id:r.id,title:r.title,path:`2.核心玩法/3.机制设计/${r.title}.md`}]));
const create=[tool('r','read_content',{id:'doc'}),tool('d','mechanism',{id:'definition',type:'definition.create',args:{id:'def-A',name:'A',type:'character',origin:'canonical',source:{documentId:'doc',quote:doc.content},fields:{personality:'careful'}}}),tool('c','mechanism',{id:'character',type:'entity.create',args:{id:'A',definitionId:'def-A',opening:true}}),text('已真实建档')];
const options={campaignId:'campaign',branchId:'branch',user:{id:'u',content:'选择A开始'},profile:{model:'qa',maxTokens:1000},settings:{systemPrompt:'rules',autoCompact:true},messages:[]};
test('real host tool loop delegates, checkpoints, rolls and commits once; resume never creates duplicate game state',async()=>{
  const seq=[tool('delegate','delegate',{role:'analysis',task:'按原文建立A'}),...create,new Error('network interrupted'),text('本轮建档完成')];
  const {runtime,db,store}=await fixture(seq);await assert.rejects(runtime.execute(options),/network/);
  assert.equal(Object.keys((await db.get('campaign','branch')).world.entities).length,0);
  assert.equal((await store.list('rolls')).length,1);
  const run=await runtime.execute(options);assert.equal(run.status,'complete');assert.equal((await db.get('campaign','branch')).world.entities.A.forms.normal.hp,100);assert.equal((await store.list('rolls')).length,1);assert.equal((await store.list('events')).length,1);assert.equal((await store.list('turns')).length,1);
  await runtime.execute(options);assert.equal((await store.list('events')).length,1);
});
test('plan tool creates actual pending UI data and executes only after confirmation',async()=>{
  const plan={goal:'建立A',steps:[{id:'s',agent:'analysis',task:'按原文建立角色',dependencies:[],tools:['read_content','mechanism']}]};
  const seq=[tool('plan','propose_plan',plan),text('请确认计划'),tool('delegate','delegate',{role:'analysis',task:'执行建立A'}),...create,text('已执行')];
  const{runtime,db,store}=await fixture(seq);const pending=await runtime.execute({...options,planMode:true});assert.equal(pending.status,'awaiting-plan');assert.equal((await store.list('rolls')).length,0);assert.equal((await db.get('campaign','branch')).world.revision,0);
  const done=await runtime.execute({...options,confirmedPlan:pending.plan,planMode:true});assert.equal(done.status,'complete');assert.equal(done.plan.status,'executed');assert.equal((await db.get('campaign','branch')).world.revision,1);
});
test('generated characters are persisted before intelligence can record their knowledge',async()=>{
  const generated={id:'C',name:'过渡角色',kind:'character',location:'深圳',basis:'玩家本轮捏人：谨慎的过渡角色',reason:'原始资料没有该过渡角色，按玩家输入固定一次。',definition:{fields:{personality:'谨慎',forms:{normal:{hp:100,mp:40,attack:20,defense:5,speed:15}}}}};
  const seq=[tool('ensure','ensure_entity',generated),tool('knowledge','mechanism',{id:'knowledge-1',type:'knowledge.record',args:{id:'known-c',subjectId:'C',field:'name',value:'过渡角色',knowers:['C'],status:'observation',source:'玩家当面介绍',basis:'玩家在本轮明确介绍了自己的名字。'}}),text('已建档并登记本轮情报')];
  const{runtime,db}=await fixture(seq);const done=await runtime.execute({...options,user:{id:'generated',content:'请先捏出一个过渡角色，再登记他知道自己的名字。'}});const world=(await db.get('campaign','branch')).world;
  assert.equal(done.status,'complete',JSON.stringify({done,world}));assert.equal(world.entities.C?.name,'过渡角色',JSON.stringify({done,world}));assert.equal(world.knowledge['known-c'].knowers[0],'C');assert.equal(world.revision,1);
});
test('formal characters mentioned in a game opening are registered from the catalog before the model runs',async()=>{
  const seq=[text('已读取正式角色档案')];
  const {runtime,db,calls}=await fixture(seq);
  const done=await runtime.execute({...options,user:{id:'formal-opening',content:'扮演A开始游戏'}}); 
  const world=(await db.get('campaign','branch')).world;
  assert.equal(done.status,'complete',JSON.stringify(done));
  assert.equal(world.entities['canonical:doc']?.name,'A',JSON.stringify({world,trace:done.trace}));
  assert.equal(world.entities['canonical:doc']?.kind,'character');
  assert.equal(world.entities.player?.kind,'player');
  assert.equal(world.definitions['canonical:doc']?.origin,'canonical');
  assert.equal(world.definitions['canonical:doc']?.source?.documentId,'doc');
  assert.equal(calls.length,1);
  assert.equal(world.revision,1);
});
test('mentioning a formal character in a settings question does not mutate the campaign',async()=>{
  const seq=[text('设置说明完毕')];
  const {runtime,db}=await fixture(seq);
  const done=await runtime.execute({...options,user:{id:'settings-question',content:'请解释月晓菲的提示词设置'}}); 
  const world=(await db.get('campaign','branch')).world;
  assert.equal(done.status,'complete',JSON.stringify(done));
  assert.deepEqual(world.entities,{});
  assert.deepEqual(world.definitions,{});
  assert.equal(world.revision,0);
});
test('canonical definition calls obtain the original document and labeled numeric evidence themselves',async()=>{
  const definition={id:'formal-definition',name:'A',type:'character',origin:'canonical',source:{documentId:'doc'},fields:{age:25,forms:{normal:{hp:100,mp:40,attack:25,defense:5,speed:15},transformed:{hp:300,mp:80,attack:180,defense:6,speed:40}}}};
  const seq=[tool('definition','mechanism',{id:'formal-definition-op',type:'definition.create',args:definition}),tool('entity','mechanism',{id:'formal-entity-op',type:'entity.create',args:{id:'A',definitionId:'formal-definition',kind:'player',opening:true}}),text('已按正式原文建档')];
  const {runtime,db}=await fixture(seq);
  const done=await runtime.execute({...options,user:{id:'definition-source',content:'开始游戏'}});const world=(await db.get('campaign','branch')).world;
  assert.equal(done.status,'complete',JSON.stringify({done,world}));assert.equal(world.definitions['formal-definition']?.source?.quote,doc.content,JSON.stringify({done,world}));assert.equal(world.definitions['formal-definition']?.fields?.age,25);assert.equal(world.entities.A?.name,'A');
});
test('the complete Xiaofei opening instruction auto-registers the formal role from original content',async()=>{
  const xiaofei={...doc,id:'xiaofei',entityId:'document:xiaofei',path:'3.游戏内容/1.参与角色/月晓菲/月晓菲.md',aliases:['月晓菲','“晓菲”'],content:doc.content.replace('name: A','name: 月晓菲')};
  const opening=['请你以第一人称视角，扮演"月晓菲"','保证月晓菲的性格特征(傲慢、狡诈、伪善）','确保40%内容为内心独白，50%为对话内容，肢体描写尽量角色的肢体动作是什么，尤其是腿部。角色语言优雅，冷静','输出内容确保口语化','','大白天，你在和user即将扮演的身份交流着，进行闲聊','根据月晓菲的背景故事 和她对于剿灭邪恶的决心 输出开场白','并决定user即将扮演的人物，以及他的身份、如何和月晓菲认识、并之后准备一起行动','','随后，引导月晓菲该做任务了，于是月晓菲开始查阅情报并随机抽出三个任务，让user参与一起思考','','详细描写上述过程','现在时间：2020年5月16日。'].join('\\n');
  const player={name:'测试玩家',identity:'深圳活动协调员',acquaintance:'与月晓菲在展会相识',basis:'玩家允许决定开局身份',reason:'新捏玩家参数固定一次',definition:{fields:{personality:'谨慎',forms:{normal:{hp:100,mp:1,attack:10,defense:10,speed:10}}}}};
  const quests=[1,2,3].map(i=>({name:`任务${i}`,goal:'调查当前线索',completion:'核实线索',failure:'错过时机',location:'深圳',level:1,hiddenFailure:`事先固定失败条件${i}`}));
  const {runtime,db,calls}=await fixture([tool('opening','prepare_opening',{player,quests}),text('已读取正式原文并完成建档')],[xiaofei]);
  const done=await runtime.execute({...options,user:{id:'xiaofei-opening',content:opening}});
  const world=(await db.get('campaign','branch')).world,entity=world.entities['canonical:document:xiaofei'],definition=world.definitions['canonical:xiaofei'];
  assert.equal(done.status,'complete',JSON.stringify(done));assert.equal(entity?.name,'月晓菲');assert.equal(entity?.kind,'character');assert.deepEqual(entity?.forms.normal,{hp:100,mp:40,attack:25,defense:5,speed:15});assert.equal(definition?.source?.documentId,'xiaofei');assert.equal(definition?.source?.quote,xiaofei.content);assert.equal(calls.length,1);assert.equal(world.entities.player.name,'测试玩家');assert.ok(world.entities.player.forms);assert.equal(Object.keys(world.quests).length,3);assert.equal(world.opening.completed,true);
});
test('provider tool deltas assemble stable calls, usage and public summaries without displaying hidden reasoning',async()=>{
  const packets=[{choices:[{delta:{tool_calls:[{index:0,id:'call',function:{name:'read_',arguments:'{"id":'}}],reasoning_content:'hidden internal'}}]},{choices:[{delta:{tool_calls:[{index:0,function:{name:'state',arguments:'"A"}'}}],reasoning_summary:'公开摘要'}}]},{choices:[{delta:{},finish_reason:'tool_calls'}],usage:{prompt_tokens:123,completion_tokens:10}}];
  const fetcher=async(path)=>path.endsWith('/status')?Response.json({data:[{id:'qa'}]}):new Response(packets.map(p=>`data: ${JSON.stringify(p)}\n\n`).join('')+'data: [DONE]\n\n');
  const client=new ModelClient({headers:()=>({})},fetcher);const result=await client.turn({model:'qa',protocol:'openai',baseUrl:'http://example.test/v1'},[],{tools:[{type:'function',function:{name:'read_state'}}]});assert.equal(result.tools[0].function.name,'read_state');assert.deepEqual(JSON.parse(result.tools[0].function.arguments),{id:'A'});assert.equal(result.summary,'公开摘要');assert.equal(result.usage.prompt_tokens,123);assert.equal(JSON.stringify(result).includes('hidden internal'),false);
});
test('backup failure preserves authoritative local branch and migration metadata until verified synchronization',async()=>{
  const store=new LocalStore('sessions',new IDBFactory());await store.ready;let remote={version:1,revision:1,messages:[],draft:'legacy',handoff:'',selectedDocs:[]},fail=true;
  const bridge={savedSession:()=>remote,writeBackup:async data=>{if(fail)throw new Error('offline');return{path:'file',sha256:'hash'};},saveSession:async(key,value)=>{remote=value;}};const sessions=new CampaignSessions(bridge,store);const{session}=await sessions.load('chat');assert.equal(session.draft,'legacy');session.draft='durable';session.revision++;
  await assert.rejects(sessions.sync('chat',session),/offline/);assert.equal(remote.version,1);assert.equal((await sessions.load('chat')).session.draft,'durable');fail=false;await sessions.sync('chat',session);assert.equal(remote.format,'lantern-campaign-v2');assert.equal(remote.session,undefined);assert.equal(remote.backup.path,'file');
});
