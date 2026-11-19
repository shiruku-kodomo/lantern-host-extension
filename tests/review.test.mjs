import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {IDBFactory} from 'fake-indexeddb';
import {normalizeSettings,emptySession} from '../src/core.js';
import {AGENT_PROMPTS} from '../src/agent-prompts.js';
import {HostRuntime,agentTools} from '../src/agents.js';
import {LocalStore} from '../src/storage.js';
import {GameDatabase,CampaignSessions,branchKey} from '../src/game-db.js';
import {DocumentLibrary} from '../src/documents.js';
import {ExtensionUpdater,REPOSITORY,officialRemote} from '../src/updater.js';
import {MechanismEngine} from '../src/mechanisms.js';
import {characterContext} from '../src/mechanisms.js';
import {ContentRegistry,ruleClosure} from '../src/rules.js';
import {projectKnowledge} from '../src/worldbook.js';

test('legacy prompt append/replace migrates once and the saved editor text is exactly the runtime role prompt',()=>{
  for(const mode of [undefined,'append','replace']){
    const settings=normalizeSettings({agentPrompts:{analysis:'我的规则'},agentPromptModes:{analysis:mode}});
    assert.equal(settings.agentPrompts.analysis,mode==='replace'?'我的规则':`${AGENT_PROMPTS.analysis}\n我的规则`);
    assert.deepEqual(normalizeSettings(settings),settings);
  }
  const edited=normalizeSettings({agentPromptVersion:2,agentPrompts:{host:'直接编辑的主持规则'}});
  assert.equal(edited.agentPrompts.host,'直接编辑的主持规则');assert.equal(edited.agentPromptModes,undefined);
});

test('plan tools exclude character creation, opening batches, dice and all state mutations',()=>{
  for(const role of Object.keys(AGENT_PROMPTS)){
    const names=agentTools(role,true).map(t=>t.function.name);
    for(const forbidden of ['ensure_entity','prepare_opening','execute_inquiry','execute_combat_block','roll_dice','mechanism'])assert.ok(!names.includes(forbidden),`${role} exposes ${forbidden}`);
  }
});
test('all roles share registered mechanisms and dice',()=>{
  const host=agentTools('host').find(t=>t.function.name==='mechanism').function.parameters.properties.type.enum;
  for(const role of Object.keys(AGENT_PROMPTS)){const tools=agentTools(role);assert.deepEqual(tools.find(t=>t.function.name==='mechanism').function.parameters.properties.type.enum,host);assert.ok(tools.some(t=>t.function.name==='roll_dice'));}
});
test('changing a model-supplied turn label cannot roll a second random event in the same player turn',async()=>{
  const call=(id,turnId)=>({id,type:'function',function:{name:'mechanism',arguments:JSON.stringify({id,type:'random.event',args:{turnId,explicitRequest:true,affected:[]}})}});
  const f=await openingFixture([{text:'',tools:[call('event-one','model-label-one'),call('event-two','model-label-two')]},{text:'本轮事件类别已确定。',tools:[]}]);
  await f.runtime.execute({...f.options,user:{id:'real-player-turn',content:'现在实际抽取一次突发事件，只确定事件类别。'}});
  assert.equal((await f.store.list('rolls')).length,1);
  const world=(await f.db.get('c','b')).world;
  assert.deepEqual(Object.keys(world.claims),['random:real-player-turn']);
});

const player={name:'许知行',identity:'深圳活动协调员',acquaintance:'展会工作时与月晓菲相识',basis:'玩家要求主持确定身份和相识经过',reason:'本局新捏玩家，固定一次',definition:{fields:{personality:'务实谨慎',forms:{normal:{hp:100,mp:1,attack:10,defense:10,speed:10}}}}};
const quests=[1,2,3].map(i=>({name:`测试任务${i}`,goal:'调查线索',completion:'核实事实',failure:'错过期限',hiddenFailure:`预先确定的后台条件${i}`,location:'深圳',level:1}));
const tool=(args)=>({text:'',summary:'',tools:[{id:'opening',type:'function',function:{name:'prepare_opening',arguments:JSON.stringify(args)}}]});
async function openingFixture(sequence){
  const store=new LocalStore('review',new IDBFactory());await store.ready;
  const db=new GameDatabase(store);await db.create('c','b');
  const library=await new DocumentLibrary(store,new URL('../content/',import.meta.url),async url=>new Response(await readFile(url))).init();
  const requests=[];const model={turn:async(p,m,o)=>{requests.push({messages:structuredClone(m),tools:o.tools.map(t=>t.function.name)});const next=sequence.shift();if(next instanceof Error)throw next;assert.ok(next,'unexpected model request');return next;}};
  const runtime=new HostRuntime({store,db,library,model,projection:{sync:async()=>({revision:1})}});
  const options={campaignId:'c',branchId:'b',user:{id:'u',content:'请你以第一人称扮演"月晓菲"，为user决定身份、如何认识月晓菲，然后随机抽出三个任务。现在时间：2020年5月16日'},profile:{model:'test',maxTokens:4096},settings:normalizeSettings({}),messages:[]};
  return{store,db,runtime,options,requests};
}
test('real bundled Xiaofei opens in two model turns: fixed NPC, player panel, known facts and three unaccepted tasks; replay does not reroll',async()=>{
  const f=await openingFixture([tool({player,quests}),{text:'已保存，等待玩家选择。',tools:[]}]);
  const run=await f.runtime.execute(f.options),w=(await f.db.get('c','b')).world;
  assert.equal(run.status,'complete');assert.ok(f.requests.every(r=>['prepare_opening','mechanism','roll_dice'].every(name=>r.tools.includes(name))));
  const role=Object.values(w.entities).find(e=>e.name==='月晓菲');
  assert.equal(role.kind,'character');assert.deepEqual(role.forms.normal,{hp:150,mp:30,attack:20,defense:15,speed:5});
  assert.ok(role.affection>=71&&role.affection<=90);assert.match(role.personality,/傲慢/);assert.equal(role.location,'深圳');
  assert.equal(w.entities.player.name,player.name);assert.ok(w.entities.player.forms);assert.equal(w.entities.player.wallet,undefined);
  assert.equal(Object.keys(w.quests).length,3);assert.ok(Object.values(w.quests).every(q=>q.status==='offered'));
  assert.ok(Object.values(w.knowledge).some(k=>k.field==='初始情报'&&k.knowers.includes(role.id)));
  assert.equal(JSON.stringify(f.requests[0].messages).includes('文生图专用外观描述'),false);
  const rolls=await f.store.list('rolls');assert.equal(rolls.length,4);
  await f.runtime.execute(f.options);assert.equal((await f.store.list('rolls')).length,rolls.length);assert.equal((await f.store.list('events')).length,1);
});
test('bad opening batch leaves no partial player definition; repair resumes the same opening and uses existing dice',async()=>{
  const invalid=structuredClone(player);invalid.definition.fields.forms.normal.mp=0;
  const sequence=[tool({player:invalid,quests}),new Error('network stopped')];
  const f=await openingFixture(sequence);
  await assert.rejects(f.runtime.execute(f.options),/network stopped/);
  const checkpoint=(await f.store.list('runs'))[0];
  assert.ok(!checkpoint.world.entities.player.forms);assert.ok(!checkpoint.world.definitions['generated:player']);
  assert.match(checkpoint.trace.find(t=>t.status==='failed').error,/normal.mp/);
  const corrected=tool({player,quests});corrected.tools[0].id='corrected-opening';
  sequence.push(corrected,{text:'建档完成，等待选择。',tools:[]});
  const done=await f.runtime.execute(f.options);assert.equal(done.status,'complete');
  assert.equal((await f.store.list('rolls')).length,4);
  assert.equal((await f.db.get('c','b')).world.entities.player.name,player.name);
});
test('refresh preserves a fork that is pending backup rather than restoring the old remote branch',async()=>{
  const store=new LocalStore('branch-review',new IDBFactory());await store.ready;
  const db=new GameDatabase(store),old=await db.create('c','old');
  const next={...old,branchId:'new',session:{...emptySession(),draft:'新分支草稿'}};
  await store.write('branches','c:new',next);
  const remote={format:'lantern-campaign-v2',campaignId:'c',branchId:'old'};
  await store.write('bindings','chat',{...remote,branchId:'new'});await store.write('outbox','c:new',{type:'backup'});
  const sessions=new CampaignSessions({savedSession:()=>remote},store);
  const restored=await sessions.load('chat');assert.equal(restored.session.draft,'新分支草稿');assert.equal(sessions.current('chat').binding.branchId,'new');
});
test('a world commit during file backup leaves the backup queue pending even when session revision is unchanged',async()=>{
  const store=new LocalStore('queue-review',new IDBFactory());await store.ready;let remote=null,sessions;
  const bridge={savedSession:()=>remote,saveSession:async(k,value)=>{remote=value;},writeBackup:async data=>{
    const world=structuredClone(data.branch.world);world.nextStop='备份期间的新结算';
    await sessions.db.commit(data.branch.campaignId,data.branch.branchId,{id:'concurrent',baseRevision:world.revision,world,operations:[],source:{}});
    return {path:'test-backup',sha256:'test-hash'};
  }};
  sessions=new CampaignSessions(bridge,store);const {session}=await sessions.load('chat');session.revision++;
  await sessions.sync('chat',session);const {campaignId,branchId}=sessions.current('chat').binding;
  assert.ok(await store.read('outbox',branchKey(campaignId,branchId)));
  assert.equal((await sessions.db.get(campaignId,branchId)).world.revision,1);
});
test('quest board validates all hidden facts before rolling its first die',async()=>{
  const f=await openingFixture([]),world=(await f.db.get('c','b')).world;
  world.quests=Object.fromEntries(quests.map((q,i)=>[String(i),{...q,status:'offered'}]));delete world.quests['1'].hiddenFailure;
  const engine=new MechanismEngine({db:f.db,campaignId:'c',branchId:'b',registry:{rules:async()=>[]},runId:'test'});
  await assert.rejects(engine.execute(world,{id:'board',type:'quest.board',args:{questIds:['0','1','2']}}),/投骰前/);
  assert.equal((await f.store.list('rolls')).length,0);
});
test('specialist context stays separate; host retains independent dice tools after delegation',async()=>{
  const call=(id,name,args)=>({text:'',tools:[{id,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
  const check={id:'inquiry',purpose:'当前单一询问行动',sides:20,count:1,modifiers:[]};
  const sequence=[call('d','delegate',{role:'judgment',task:'为本轮唯一询问投骰'}),call('r','roll_dice',check),{text:'判定已完成。',tools:[]},call('r2','roll_dice',{...check,id:'different-id'}),{text:'复用判定结果。',tools:[]}];
  const f=await openingFixture(sequence);
  const run=await f.runtime.execute({...f.options,user:{id:'check-only',content:'进行一次询问判定'},messages:[{role:'user',content:'OLD_NARRATOR_STYLE 40%内心独白与第一人称长文'}]});
  assert.equal((await f.store.list('rolls')).length,2);
  assert.equal(JSON.stringify(f.requests[1].messages).includes('OLD_NARRATOR_STYLE'),false);
  assert.equal(f.requests[3].tools.includes('roll_dice'),true);
  const delegated=run.trace.find(t=>t.tool==='delegate'&&t.status==='complete').result;
  assert.equal(delegated.checks.length,1);assert.ok(delegated.checks[0].raw.length);
  assert.ok(!run.trace.some(t=>t.tool==='roll_dice'&&t.status==='failed'));
});
test('model rules query returns only requested originals while engine validation still loads the dependency closure',async()=>{
  const f=await openingFixture([]),registry=new ContentRegistry(f.runtime.library);
  assert.deepEqual((await registry.rules(['quest'],{includeDependencies:false})).map(d=>d.rule),['quest']);
  assert.equal((await registry.rules(['quest'])).length,ruleClosure(['quest']).length);
});
test('single inquiry is declared once, rolls once, records only its participants and replays without new dice',async()=>{
  const args={purpose:'在当前地点向工作人员询问时间线索',actors:['A'],subjectId:'q',minutes:10,success:'工作人员提供了一条待核实说法',failure:'本次未获得可靠线索'};
  const sequence=[{text:'',tools:[{id:'inquiry',type:'function',function:{name:'execute_inquiry',arguments:JSON.stringify(args)}}]},{text:'本次询问完成，等待下一选择。',tools:[]}];
  const f=await openingFixture(sequence),world=(await f.db.get('c','b')).world;world.entities.A={id:'A',name:'A'};
  await f.db.commit('c','b',{id:'seed',baseRevision:0,world,operations:[],source:{}});
  const options={...f.options,user:{id:'inquiry',content:'先与工作人员交谈核实，只推进这一项调查行动。'}};
  const run=await f.runtime.execute(options),after=(await f.db.get('c','b')).world;
  assert.ok(f.requests.every(r=>r.tools.includes('execute_inquiry')&&r.tools.includes('mechanism')));assert.equal(run.inquiry.completed,true);
  assert.equal(after.time,10);assert.equal(Object.keys(after.knowledge).length,1);assert.deepEqual(Object.values(after.knowledge)[0].knowers,['A']);
  assert.equal((await f.store.list('rolls')).length,1);await f.runtime.execute(options);assert.equal((await f.store.list('rolls')).length,1);
});
test('inquiry stops at an intervening deadline without claiming a result or spending an inquiry die',async()=>{
  const args={purpose:'询问时间线索',actors:['A'],subjectId:'q',minutes:10,success:'不应出现的线索',failure:'不应出现的失败结果'};
  const f=await openingFixture([{text:'',tools:[{id:'inquiry',type:'function',function:{name:'execute_inquiry',arguments:JSON.stringify(args)}}]},{text:'到达期限，等待选择。',tools:[]}]);
  const world=(await f.db.get('c','b')).world;world.entities.A={id:'A'};world.quests.q={id:'q',status:'active',deadline:5};
  await f.db.commit('c','b',{id:'seed',baseRevision:0,world,operations:[],source:{}});
  const run=await f.runtime.execute({...f.options,user:{id:'inquiry',content:'先与工作人员交谈，只推进这一项调查。'}});
  assert.equal(run.inquiry.interrupted,true);assert.equal((await f.db.get('c','b')).world.time,5);
  assert.equal((await f.store.list('rolls')).length,0);assert.equal(Object.keys((await f.db.get('c','b')).world.knowledge).length,0);
});
test('one declared combat block performs five exchanges and ten dice, applies mandatory defeat, then replays without rerolling',async()=>{
  const args={id:'batch-combat',allies:['A'],enemies:['E'],majorEnemyId:'E',basis:'测试明确要求仅结算一个五次交锋块',rounds:Array.from({length:5},()=>({action:'正面攻击',attackerSide:'allies',defenseField:'defense'}))};
  const f=await openingFixture([{text:'',tools:[{id:'block',type:'function',function:{name:'execute_combat_block',arguments:JSON.stringify(args)}}]},{text:'本块完成，等待下一选择。',tools:[]}]);
  const {fraction:F}=await import('../src/exact.js');const world=(await f.db.get('c','b')).world;
  const panel={hp:100,mp:20,attack:20,defense:20,speed:20};
  const make=(id,kind)=>({id,name:id,definitionId:id,kind,form:'normal',forms:{normal:{...panel}},hp:F(100),mp:F(20),hpRatio:F(1),mpRatio:F(1),skills:[],training:0,defeats:0});
  world.entities.A=make('A','character');world.entities.E=make('E','troop');
  world.entities.E.forms.normal.defense=1000000;world.quests.q={id:'q',status:'active',doomed:true};
  await f.db.commit('c','b',{id:'seed',baseRevision:0,world,operations:[],source:{}});
  const options={...f.options,user:{id:'battle',content:'结算这一个五次交锋块，到下一选择停下。'}};
  const run=await f.runtime.execute(options),after=(await f.db.get('c','b')).world;
  assert.equal(run.combatBlock.completed,true);assert.equal(after.battles[args.id].rounds.length,5);assert.equal((await f.store.list('rolls')).length,10);
  assert.equal(after.battles[args.id].status,'defeat');assert.equal(after.entities.A.defeats,1);
  assert.ok(!after.entities.A.formalDefeat);assert.equal(f.requests.length,1);
  await f.runtime.execute(options);assert.equal((await f.store.list('rolls')).length,10);
});
test('combat interruption after the third actual die resumes the same declarations and reuses those three dice',async()=>{
  const args={id:'resume-block',allies:['A'],enemies:['E'],majorEnemyId:'E',basis:'固定战斗声明',rounds:Array.from({length:5},()=>({action:'攻击',attackerSide:'allies',defenseField:'defense'}))};
  const f=await openingFixture([{text:'',tools:[{id:'block',type:'function',function:{name:'execute_combat_block',arguments:JSON.stringify(args)}}]},{text:'恢复完成。',tools:[]}]);
  const {fraction:F}=await import('../src/exact.js'),world=(await f.db.get('c','b')).world,panel={hp:100,mp:20,attack:20,defense:20,speed:20};
  for(const id of ['A','E'])world.entities[id]={id,name:id,kind:id==='A'?'character':'troop',forms:{normal:{...panel}},form:'normal',hp:F(100),mp:F(20),hpRatio:F(1),mpRatio:F(1),training:0,defeats:0,skills:[]};
  await f.db.commit('c','b',{id:'seed',baseRevision:0,world,operations:[],source:{}});
  const write=f.store.write.bind(f.store);let interrupted=false;
  f.store.write=async(store,key,value)=>{if(!interrupted&&store==='runs'&&value.trace.filter(t=>t.tool==='roll_dice'&&t.status==='complete').length===3){interrupted=true;throw new Error('test storage interruption');}return write(store,key,value);};
  const options={...f.options,user:{id:'battle-recovery',content:'执行一个五次交锋块，下一选择停止。'}};
  await assert.rejects(f.runtime.execute(options),/storage interruption/);
  const first=await f.store.list('rolls');assert.equal(first.length,3);assert.equal((await f.db.get('c','b')).world.battles[args.id],undefined);
  const done=await f.runtime.execute(options);assert.equal(done.status,'complete');const all=await f.store.list('rolls');assert.equal(all.length,10);
  for(const old of first)assert.deepEqual(all.find(r=>r.id===old.id).raw,old.raw);
});
test('one character learning an updated fact never silently teaches the other knowers; explicit sharing replaces their old belief',async()=>{
  const f=await openingFixture([]);let world=(await f.db.get('c','b')).world;
  world.entities={A:{id:'A',name:'A'},B:{id:'B',name:'B'}};
  const engine=new MechanismEngine({db:f.db,campaignId:'c',branchId:'b',registry:{rules:async()=>[]},runId:'knowledge-review'});
  const execute=async(id,type,args)=>{const applied=await engine.execute(world,{id,type,args});world=applied.world;};
  const fact={id:'k',subjectId:'org',field:'据点',value:'旧位置',knowers:['A','B'],status:'verified',source:'共同得知'};
  await execute('initial','knowledge.record',fact);
  await execute('update','knowledge.record',{...fact,value:'新位置',knowers:['A'],source:'A单独调查'});
  assert.equal(characterContext(world,'A').knowledge.find(k=>k.id==='k').value,'新位置');
  assert.ok(!characterContext(world,'B').knowledge.some(k=>k.value==='新位置'));
  assert.ok(characterContext(world,'B').knowledge.some(k=>k.value==='旧位置'));
  await execute('share','knowledge.share',{id:'k',from:'A',to:'B',basis:'实际当面说明更正'});
  assert.ok(characterContext(world,'B').knowledge.some(k=>k.value==='新位置'));
  assert.ok(!characterContext(world,'B').knowledge.some(k=>k.value==='旧位置'));
  await execute('new-proof','knowledge.record',{...fact,value:'新位置',knowers:['A'],source:'A独有的秘密证明'});
  assert.ok(!characterContext(world,'B').knowledge.some(k=>k.source==='A独有的秘密证明'));
  const bProjection=projectKnowledge(world).content.split('【B｜B 已知】')[1];
  assert.ok(!bProjection.includes('A独有的秘密证明'));
});

function updaterBridge(version,after=version){
  const calls=[];let updated=false;
  return {calls,headers:()=>({}),fetch:async()=>Response.json({version:'0.3.3'}),http:async(path,payload)=>{
    calls.push({path,payload});if(path.endsWith('/discover'))return [{name:'third-party/lantern-host-extension',type:'global'}];
    if(path.endsWith('/version'))return updated?after:version;
    if(path.endsWith('/update')){updated=true;return {};}
    if(path.endsWith('/branches')||path.endsWith('/switch'))return null;
    throw new Error('unexpected endpoint');
  }};
}
test('updater never treats unmanaged installs or missing remote status as latest',async()=>{
  const manual=await new ExtensionUpdater(updaterBridge({currentCommitHash:'',remoteUrl:'',isUpToDate:true})).check();
  assert.equal(manual.state,'manual');assert.equal(manual.managed,false);
  const unknown=await new ExtensionUpdater(updaterBridge({currentCommitHash:'a',remoteUrl:REPOSITORY,currentBranchName:'stable'})).check();assert.equal(unknown.state,'unknown');
  const broken=updaterBridge({});broken.http=async()=>{throw new Error('offline');};await assert.rejects(new ExtensionUpdater(broken).check(),/offline/);
});
test('updater rechecks scope and origin, fetches stable before switching, and reads installed manifest',async()=>{
  const bridge=updaterBridge({currentCommitHash:'a',remoteUrl:`${REPOSITORY}.git/`,currentBranchName:'main',isUpToDate:true},{currentCommitHash:'b',remoteUrl:REPOSITORY,currentBranchName:'stable',isUpToDate:true});
  const result=await new ExtensionUpdater(bridge).install({managed:true,scope:{global:false}});
  assert.equal(result.version,'0.3.3');assert.ok(bridge.calls.filter(c=>c.payload).every(c=>c.payload.global===true));
  assert.ok(bridge.calls.findIndex(c=>c.path.endsWith('/branches'))<bridge.calls.findIndex(c=>c.path.endsWith('/switch')));
  assert.equal(officialRemote('https://example.com/shiruku-kodomo/lantern-host-extension'),false);
  assert.equal(officialRemote('git@github.com:shiruku-kodomo/lantern-host-extension.git'),true);
  await assert.rejects(new ExtensionUpdater(updaterBridge({currentCommitHash:'a',remoteUrl:'https://github.com/other/project',currentBranchName:'stable'})).install(),/来源/);
});
test('dual installs update the scope actually loaded by Tavern; an unknown loaded scope is never guessed',async()=>{
  const bridge=updaterBridge({currentCommitHash:'a',remoteUrl:REPOSITORY,currentBranchName:'stable',isUpToDate:true});
  const http=bridge.http;bridge.http=(path,payload)=>path.endsWith('/discover')?Promise.resolve([{name:'third-party/lantern-host-extension',type:'local'},{name:'third-party/lantern-host-extension',type:'global'}]):http(path,payload);
  bridge.extensionType=async()=> 'global';assert.equal((await new ExtensionUpdater(bridge).scope()).global,true);
  bridge.extensionType=async()=> 'local';assert.equal((await new ExtensionUpdater(bridge).scope()).global,false);
  bridge.extensionType=async()=> null;await assert.rejects(new ExtensionUpdater(bridge).scope(),/实际加载范围/);
});
