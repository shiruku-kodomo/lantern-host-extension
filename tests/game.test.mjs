import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { LocalStore } from '../src/storage.js';
import { GameDatabase, CampaignSessions, emptyWorld, branchKey } from '../src/game-db.js';
import { fraction as F, compare, randomDie, sampleDice, ratioModifier, ordinary } from '../src/exact.js';
import { MechanismEngine, characterContext } from '../src/mechanisms.js';
import { ContentRegistry, ruleClosure, RULES, extractPanels, OP_RULE } from '../src/rules.js';
import { projectKnowledge, WorldbookProjection } from '../src/worldbook.js';
import { HostRuntime, handoffPackage } from '../src/agents.js';
import { contextBudget } from '../src/context.js';
import { emptySession } from '../src/core.js';
import { appendMessage, hydrateConversation } from '../src/conversation.js';

const panel = {hp:100,mp:50,attack:80,defense:40,speed:20};
function entity(id,overrides={}){return{id,name:id,kind:'character',definitionId:`d-${id}`,forms:{normal:{...panel},transformed:{...panel,hp:300,mp:150}},form:'normal',hp:F(100),mp:F(50),hpRatio:F(1),mpRatio:F(1),wallet:200,affection:60,training:0,defeats:0,location:'A',skills:[],...overrides};}
async function fixture(){const store=new LocalStore('qa',new IDBFactory());await store.ready;const db=new GameDatabase(store),branch=await db.create('campaign','branch');const registry={rules:async()=>[],definition:d=>d};const engine=new MechanismEngine({db,campaignId:'campaign',branchId:'branch',registry,runId:'run'});return{store,db,branch,engine};}
async function apply(engine,w,type,args,id=crypto.randomUUID()){return engine.execute(w,{id,type,args});}
test('IDB upgrades preserve old records; atomic event commit and dice replay reject conflicts',async()=>{
  const {store,db,branch}=await fixture();await store.put('old',{kept:true});assert.equal((await store.get('old')).kept,true);
  const world=structuredClone(branch.world);world.entities.A=entity('A');const event={id:'e',baseRevision:0,world,operations:[{id:'a'}],source:{input:'action'}};
  const receipts=await Promise.all([db.commit('campaign','branch',event),db.commit('campaign','branch',event)]);assert.ok(receipts.every(r=>r.revision===1));assert.deepEqual(receipts.map(r=>r.reused).sort(),[false,true]);assert.equal((await store.list('events')).length,1);
  await assert.rejects(db.commit('campaign','branch',{...event,operations:[{id:'changed'}]}),/CONFLICT/);
  await assert.rejects(db.commit('campaign','branch',{...event,id:'new'}),/STATE_CONFLICT/);
  let count=0;const p={purpose:'locked action',sides:20,count:1,modifiers:[]};const roll=()=>{count++;return{raw:[17],total:17};};
  const first=await db.roll('campaign','branch','check',p,roll),second=await db.roll('campaign','branch','check',p,roll);assert.equal(first.total,second.total);assert.equal(count,1);
  await assert.rejects(db.roll('campaign','branch','check',{...p,sides:6},roll),/CHECK_CONFLICT/);
});
test('random rejection sampling is unbiased at the UINT32 boundary; plain checks retain natural extremes',()=>{
  let calls=0;assert.equal(randomDie(20,a=>{a[0]=calls++===0?0xffffffff:19;}),20);assert.equal(calls,2);assert.equal(randomDie(1),1);
  const r=sampleDice({purpose:'sample',sides:20,count:1,modifiers:[{source:'prior',value:30}]},a=>a[0]=0);assert.equal(r.total,31);assert.equal(ordinary({...r,parameters:{sides:20}}),'critical-failure');
  assert.throws(()=>sampleDice({sides:0,purpose:'invalid'}));assert.deepEqual([ratioModifier(101,100),ratioModifier(150,100),ratioModifier(200,100),ratioModifier(300,100)],[2,4,6,8]);
});
test('canonical panel parser uses exact source values; generated names do not imply canonical intelligence',async()=>{
  const text='未变身：[HP:100/100][MP:40/40][Atk:25][Armor:5][Speed:15]\n变身后：[HP:300/300][MP:80/80][Atk:180][Armor:6][Speed:40]';
  assert.equal(extractPanels(text).transformed.attack,180);
  const library={read:async()=>({id:'doc',path:'3.游戏内容/1.参与角色/A.md',content:text,sha256:'v1'}),list:()=>[]};const registry=new ContentRegistry(library);await registry.read('doc');
  const d=registry.definition({id:'A',name:'A',type:'character',origin:'canonical',source:{documentId:'doc',quote:text},fields:{}});assert.equal(d.fields.forms.normal.hp,100);
  assert.throws(()=>registry.definition({id:'A',type:'character',origin:'canonical',source:{documentId:'doc',quote:text},fields:{forms:{normal:{hp:999}}}}),/MISMATCH/);
  assert.equal(Object.keys(RULES).length,25);assert.ok(ruleClosure(['combat']).includes('form'));for(const id of ['country','city','organization','troop','elite','boss','outpost','identity'])assert.ok(RULES[id]);assert.ok(Object.keys(OP_RULE).length>=35);
});
test('exact resource ratios survive form round trips; sub-unit MP cannot pay integer skill costs',async()=>{
  const{engine}=await fixture();let w=emptyWorld();w.entities.A=entity('A',{forms:{normal:{...panel,hp:3},transformed:{...panel,hp:5}},hp:F(2),hpRatio:F(2,3),mp:F(1,2),mpRatio:F(1,100),skills:['skill']});
  for(let i=0;i<40;i++){w=(await apply(engine,w,'form.switch',{entityId:'A',form:'transformed',basis:'actual intent'})).world;w=(await apply(engine,w,'form.switch',{entityId:'A',form:'normal',basis:'actual intent'})).world;}
  assert.deepEqual(w.entities.A.hp,F(2));w.definitions.skill={id:'skill',type:'skill',fields:{cost:{mp:1}}};await assert.rejects(apply(engine,w,'skill.use',{entityId:'A',definitionId:'skill',basis:'use'}),/不足/);
});
test('proposal uses frozen affection modifier; daily interaction is once per turn and narrator floor is term-specific',async()=>{
  const{engine}=await fixture();engine.dice=async(id,p)=>({raw:[10],total:10+(p.modifiers||[]).reduce((n,m)=>n+m.value,0),parameters:{sides:p.sides||20}});
  let w=emptyWorld();w.entities.A=entity('A');w.narrator='A';w.narratorTerm={floor:true};
  let r=await apply(engine,w,'relationship.propose',{entityId:'A',turnStartAffection:60,basis:'proposal'});assert.equal(r.world.entities.A.affection,55);
  r=await apply(engine,r.world,'relationship.daily',{entityId:'A',turnId:'turn',subjective:-20,basis:'hostile'});assert.equal(r.world.entities.A.affection,50);
  const again=await apply(engine,r.world,'relationship.daily',{entityId:'A',turnId:'turn',subjective:20,basis:'repeat'});assert.equal(again.world.entities.A.affection,50);
});
test('five independent combat exchanges use ratio contest and defender ties, then one health loss block',async()=>{
  const{engine}=await fixture();engine.dice=async(id,p)=>({raw:[10],total:10+(p.modifiers||[]).reduce((n,m)=>n+m.value,0),parameters:{sides:20}});
  let w=emptyWorld();w.entities.A=entity('A',{form:'transformed'});w.entities.E=entity('E',{kind:'troop'});
  w=(await apply(engine,w,'combat.start',{id:'battle',allies:['A'],enemies:['E'],majorEnemyId:'E',basis:'actual attack'})).world;
  for(let i=1;i<=5;i++)w=(await apply(engine,w,'combat.exchange',{battleId:'battle',round:i,action:'attack',defenseField:'defense'})).world;
  const r=await apply(engine,w,'combat.finish',{battleId:'battle'});assert.equal(r.result.wins,5);assert.equal(r.result.status,'victory');assert.deepEqual(r.world.entities.A.hp,F(100));
  await assert.rejects(apply(engine,r.world,'combat.exchange',{battleId:'battle',round:6,action:'attack',defenseField:'defense'}),/结束/);
});
test('growth prioritizes A even with one point difference, syncs forms, repeated enemy grants no permanent growth',async()=>{
  const{engine}=await fixture();engine.dice=async(id,p)=>({raw:[1],total:1,parameters:{sides:p.sides}});let w=emptyWorld();w.entities.A=entity('A',{hp:F(1),training:20});w.entities.E=entity('E');
  w.battles.b={id:'b',status:'victory',allies:['A'],enemies:['E'],majorEnemyId:'E',before:{A:{panel},E:{panel:{...panel,hp:101}}}};
  let r=await apply(engine,w,'growth.victory',{battleId:'b',entityId:'A',enemyId:'E',actualDefeated:true});assert.equal(r.result.tier,'A');assert.equal(r.result.delta.hp,2);assert.equal(r.world.entities.A.forms.transformed.hp,302);assert.equal(r.world.entities.A.training,10);
  r.world.battles.c={...r.world.battles.b,id:'c'};r=await apply(engine,r.world,'growth.victory',{battleId:'c',entityId:'A',enemyId:'E',actualDefeated:true});assert.equal(r.result.delta.hp,0);
  r.world.entities.A.formalDefeat=true;r=await apply(engine,r.world,'growth.defeat',{entityId:'A'});assert.equal(r.world.entities.A.forms.normal.hp,91);assert.equal(r.world.entities.A.defeats,1);
});
test('skill cost, inventory transfer, registered effects and expiry operate on actual holders and resources',async()=>{
  const{engine}=await fixture();let w=emptyWorld();w.entities.A=entity('A',{skills:['s']});w.entities.B=entity('B');w.definitions.s={id:'s',type:'skill',fields:{cost:{mp:7},effects:[{field:'hp',mode:'resource',amount:-3}]}};
  w=(await apply(engine,w,'skill.use',{entityId:'A',definitionId:'s',targets:['B'],basis:'actual use'})).world;assert.deepEqual(w.entities.A.mp,F(43));assert.deepEqual(w.entities.B.hp,F(97));
  w.definitions.i={id:'i',type:'item',fields:{effects:[{field:'hp',mode:'resource',amount:2}]}};
  w=(await apply(engine,w,'item.acquire',{definitionId:'i',holder:'A',quantity:2,instanceId:'i1',actual:true,basis:'received'})).world;
  const r=await apply(engine,w,'item.transfer',{itemId:'i1',from:'A',to:'B',quantity:1,basis:'hand over'},'transfer');w=r.world;
  assert.equal(w.items.i1.quantity,1);assert.equal(Object.values(w.items).find(i=>i.holder==='B').quantity,1);
  await assert.rejects(apply(engine,w,'item.use',{itemId:'i1',entityId:'B',basis:'not holder'}),/持有/);
});
test('quest level growth and three independent reward samples are separate from actual money delivery',async()=>{
  const{engine}=await fixture();let count=0;engine.dice=async(id,p)=>{count++;return{raw:[50],total:50,parameters:{sides:p.sides}};};let w=emptyWorld();w.entities.A=entity('A',{hp:F(23)});w.entities.B=entity('B');w.entities.P=entity('P',{wallet:1000});
  w=(await apply(engine,w,'quest.create',{id:'q',name:'q',goal:'goal',completion:'proof',failure:'deadline',location:'A',level:1})).world;
  w=(await apply(engine,w,'quest.accept',{questId:'q',leader:'A',participants:['A','B'],basis:'accepted'})).world;
  w=(await apply(engine,w,'quest.progress',{questId:'q',stepId:'step',basis:'actual proof'})).world;
  let r=await apply(engine,w,'quest.finish',{questId:'q',finalGoal:true,basis:'actual completion'});assert.equal(count,3);assert.equal(r.world.entities.A.forms.normal.attack,81);assert.deepEqual(r.world.entities.A.hp,F(23));assert.equal(r.world.entities.A.wallet,200);assert.equal(r.result.rewards.item.hit,true);assert.equal(r.result.rewards.knowledge.hit,true);assert.equal(r.result.rewards.character.hit,false);
  r=await apply(engine,r.world,'quest.pay',{questId:'q',payer:'P',amount:99});assert.deepEqual(r.result.shares,{A:50,B:49});assert.equal(r.world.entities.P.wallet,901);
});
test('currency transaction rounds whole batches exactly and commits both wallets with inventory',async()=>{
  const{engine}=await fixture();let w=emptyWorld();w.entities.A=entity('A');w.entities.B=entity('B');w.definitions.water={id:'water',type:'item',fields:{basePrice:1}};w.items.stock={id:'stock',definitionId:'water',holder:'B',quantity:10};
  let r=await apply(engine,w,'currency.quote',{id:'quote',definitionId:'water',quantity:4,multiplier:1.25});assert.equal(r.result.quote.amount,5);
  r=await apply(engine,r.world,'currency.trade',{quoteId:'quote',buyer:'A',seller:'B',itemId:'stock',accepted:true});assert.equal(r.world.entities.A.wallet,195);assert.equal(r.world.entities.B.wallet,205);assert.equal(r.world.items.stock.quantity,6);
  await assert.rejects(apply(engine,r.world,'currency.trade',{quoteId:'quote',buyer:'A',seller:'B',itemId:'stock',accepted:true}),/成交/);
});
test('rest and time stay exact; host travel accepts descriptive location differences',async()=>{
  const{engine}=await fixture();let w=emptyWorld();w.entities.A=entity('A',{hp:F(0)});for(let i=0;i<6;i++)w=(await apply(engine,w,'rest.recover',{entityId:'A',minutes:10,restId:'rest',basis:'actual rest'})).world;assert.deepEqual(w.entities.A.hp,F(10));
  const start=w.time;w.quests.q={id:'q',status:'active',deadline:start+15};const time=await apply(engine,w,'time.advance',{minutes:30,basis:'walking'});assert.equal(time.result.time,start+15);assert.equal(time.result.remaining,15);
  w=(await apply(engine,w,'route.create',{id:'r',from:'B',to:'C',mode:'walk',minutes:1,cost:0,open:false,basis:'host route'})).world;const moved=await apply(engine,w,'movement.travel',{routeId:'r',entities:['A'],basis:'host departure'});assert.equal(moved.world.entities.A.location,'C');assert.equal(moved.result.journey.departures.A,'A');
});
test('host decides event timing; event ids replay and modified 100 differs from natural 100',async()=>{
  const{engine}=await fixture();let w=emptyWorld();w.entities.A=entity('A');w.quests.q={status:'active',doomed:true};engine.dice=async()=>({raw:[60],total:100});
  let r=await apply(engine,w,'random.event',{turnId:'turn',explicitRequest:true,affected:['A']});assert.equal(r.result.category,'high-risk-choice');assert.equal(r.world.entities.A.formalDefeat,undefined);
  engine.dice=async()=>({raw:[100],total:140});r=await apply(engine,r.world,'random.event',{turnId:'turn',explicitRequest:true,affected:['A']});assert.equal(r.result.category,'high-risk-choice');const next=await apply(engine,w,'random.event',{turnId:'x',explicitRequest:false,affected:['A']});assert.equal(next.result.category,'direct-defeat');
});
test('intelligence projection preserves core facts, protects active quest clues, and character views never inherit other knowers',async()=>{
  const{engine}=await fixture();let w=emptyWorld();w.entities.A=entity('A');w.entities.B=entity('B');w.definitions.org={id:'org',origin:'canonical'};
  w=(await apply(engine,w,'knowledge.record',{id:'k',subjectId:'org',field:'name',value:'正式组织',knowers:['A'],status:'verified',source:'read ledger'})).world;
  w=(await apply(engine,w,'knowledge.record',{id:'temp',subjectId:'temporary',field:'clue',value:'过渡线索',knowers:['B'],status:'rumor',source:'witness'})).world;
  w=(await apply(engine,w,'knowledge.resolve',{id:'temp',basis:'resolved into core',replacementId:'k'})).world;
  assert.ok(!projectKnowledge(w).content.includes('过渡线索'));w.quests.q={status:'active',knowledgeIds:['temp']};assert.ok(projectKnowledge(w).content.includes('过渡线索'));
  assert.equal(characterContext(w,'B').knowledge.some(k=>k.id==='k'),false);w=(await apply(engine,w,'knowledge.share',{id:'k',from:'A',to:'B',basis:'actual radio'})).world;assert.equal(characterContext(w,'B').knowledge.some(k=>k.id==='k'),true);
});
test('worldbook creates isolated constant System @D 9999 entry, preserves manual content, and rebuilds deleted file',async()=>{
  const{store,db,branch}=await fixture();const books={base:{entries:{0:{uid:0,content:'manual'}}}};let bound='base';
  const bridge={key:()=> 'chat',context:()=>({chatMetadata:{world_info:bound}}),http:async(path,args)=>path.endsWith('/list')?Object.keys(books).map(file_id=>({file_id})):structuredClone(books[args.name]||{entries:{}}),saveWorld:async(name,data)=>{books[name]=structuredClone(data);},bindWorld:async(key,name)=>{assert.equal(key,'chat');bound=name;}};
  const projection=new WorldbookProjection(bridge,store,db);await projection.ensureInitial('campaign','chat');let w=structuredClone(branch.world);w.entities.A=entity('A');w.knowledge.k={id:'k',subjectId:'org',field:'name',value:'known',status:'verified',source:'proof',at:0,active:true,canonical:true,knowers:['A']};await db.commit('campaign','branch',{id:'e',baseRevision:0,world:w,operations:[],source:{}});
  const first=await projection.sync('campaign','branch','chat');const entry=books[first.name].entries[first.uid];assert.equal(entry.constant,true);assert.equal(entry.position,4);assert.equal(entry.role,0);assert.equal(entry.depth,9999);assert.equal(books[first.name].entries[0].content,'manual');assert.equal(books.base.entries[0].content,'manual');
  const second=await projection.sync('campaign','branch','chat');assert.equal(second.uid,first.uid);delete books[first.name];await projection.sync('campaign','branch','chat');assert.ok(books[first.name]);
});
test('historical edits fork before-action snapshot; handoff uses exact selected source message',async()=>{
  const{db,branch}=await fixture();const after=structuredClone(branch.world);after.entities.A=entity('A');await db.commit('campaign','branch',{id:'e',baseRevision:0,world:after,operations:[],source:{}});await db.archive('campaign','branch',{id:'turn',userId:'user',before:branch.world});const fork=await db.fork('campaign','branch','user');assert.equal(Object.keys(fork.world.entities).length,0);assert.equal((await db.get('campaign','branch')).world.entities.A.wallet,200);
  const s=emptySession();hydrateConversation(s);const u=appendMessage(s,{id:'u',role:'user',content:'我的原话',status:'complete'}),m=appendMessage(s,{id:'m',role:'assistant',content:'结果',status:'complete'});assert.ok(handoffPackage(s,m).includes(u.content));
});
test('model capacity uses 475k effective window and keeps output reserve separate; manual limits win',()=>{
  assert.equal(contextBudget({model:'gpt-6.1-sol',maxTokens:65000,contextWindow:128000}).capacity,475000);assert.equal(contextBudget({model:'gpt-6.1-sol',capacityMode:'manual',contextWindow:100000}).capacity,100000);
});
