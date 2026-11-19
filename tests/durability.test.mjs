import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {LocalStore} from '../src/storage.js';
import {GameDatabase,emptyWorld} from '../src/game-db.js';
import {TavernBridge} from '../src/bridge.js';
import {MechanismEngine,checkOutcome} from '../src/mechanisms.js';
import {fraction as F} from '../src/exact.js';
const panel={hp:100,mp:100,attack:100,defense:100,speed:100};
const entity=(id,more={})=>({id,name:id,definitionId:id,kind:'character',form:'normal',forms:{normal:{...panel}},hp:F(100),mp:F(100),hpRatio:F(1),mpRatio:F(1),training:0,defeats:0,skills:[],wallet:0,...more});
async function setup(){const store=new LocalStore('durability',new IDBFactory());await store.ready;const db=new GameDatabase(store);await db.create('c','b');return{store,db,engine:new MechanismEngine({db,campaignId:'c',branchId:'b',registry:{rules:async()=>[]},runId:'run'})};}
test('exchange-duration skills pay once, apply for exactly two exchanges and reject repeated block use',async()=>{
  const{engine}=await setup();engine.dice=async(id,p)=>({raw:[10],total:10+p.modifiers.reduce((n,m)=>n+m.value,0),parameters:{sides:20}});
  let w=emptyWorld();w.entities.A=entity('A');w.entities.E=entity('E',{kind:'troop'});w.definitions.skill={id:'skill',name:'guard',type:'skill',fields:{owner:'A',cost:{mp:20},target:'self',oncePerBlock:true,effects:[{field:'defense',mode:'fixed',amount:24,durationExchanges:2}]}};
  const act=async(type,args)=>{const r=await engine.execute(w,{id:`${type}-${Math.random()}`,type,args});w=r.world;return r.result;};
  await act('combat.start',{id:'battle',allies:['A'],enemies:['E'],majorEnemyId:'E',basis:'test'});await act('skill.use',{entityId:'A',definitionId:'skill',battleId:'battle',basis:'actual guard'});assert.deepEqual(w.entities.A.mp,F(80));
  await assert.rejects(act('skill.use',{entityId:'A',definitionId:'skill',battleId:'battle',basis:'again'}),/已经使用/);
  await act('combat.exchange',{battleId:'battle',round:1,action:'defend',attackerSide:'enemies',defenseField:'defense'});assert.equal(Object.values(w.effects)[0].remainingExchanges,1);
  await act('combat.exchange',{battleId:'battle',round:2,action:'defend',attackerSide:'enemies',defenseField:'defense'});assert.equal(Object.values(w.effects)[0].active,false);
  w.definitions.dot={id:'dot',type:'effect',fields:{field:'hp',mode:'periodic',amount:-3,intervalMinutes:10,durationMinutes:20}};
  await act('effect.apply',{entityId:'A',definitionId:'dot'});
  const first=await act('time.advance',{minutes:30,basis:'time actually passed'});assert.equal(first.time,10);assert.deepEqual(w.entities.A.hp,F(97));
  const second=await act('time.advance',{minutes:first.remaining,basis:'continue to next node'});assert.equal(second.time,20);assert.deepEqual(w.entities.A.hp,F(94));
  await act('time.advance',{minutes:10,basis:'after expiry'});assert.deepEqual(w.entities.A.hp,F(94));
});
test('boss stage advance retains actual MP and forbids premature final rewards',async()=>{
  const{engine}=await setup();let w=emptyWorld();w.entities.A=entity('A');w.entities.B=entity('B',{form:'human',forms:{human:{...panel,mp:14400},true:{...panel,mp:24000}},mp:F(12000),mpRatio:F(5,6)});w.definitions.B={id:'B',type:'character',fields:{battlePhases:['human','true'],formResourceMode:'absolute'}};w.battles.b={id:'b',status:'phase-victory',majorEnemyId:'B',phaseIndex:0};
  await assert.rejects(engine.execute(w,{id:'bad',type:'growth.victory',args:{entityId:'A',enemyId:'B',battleId:'b',actualDefeated:true}}),/资格/);
  const r=await engine.execute(w,{id:'phase',type:'combat.phase',args:{battleId:'b',actualShellBroken:true,basis:'human shell actually broken'}});assert.equal(r.world.entities.B.form,'true');assert.deepEqual(r.world.entities.B.mp,F(12000));assert.deepEqual(r.world.entities.B.mpRatio,F(1,2));assert.equal(r.world.entities.A.forms.normal.hp,100);
});
test('host decides boss encounters without hardcoded campaign and location gates',async()=>{
  const{engine}=await setup();const w=emptyWorld();w.entities.A=entity('A');w.entities.B=entity('B',{kind:'world-boss'});
  const r=await engine.execute(w,{id:'battle',type:'combat.start',args:{id:'b',allies:['A'],enemies:['B'],majorEnemyId:'B',basis:'host arranged encounter'}});assert.equal(r.world.battles.b.status,'active');
});
test('same-event player ending has priority over world-boss result at final commit',()=>{
  const w=emptyWorld();w.entities.A=entity('A',{training:100});w.entities.B=entity('B',{kind:'world-boss',defeated:true});w.targets=['A'];checkOutcome(w);assert.equal(w.outcome,null);checkOutcome(w,true);assert.equal(w.outcome,'player-wins');
});
test('chunked native-file backup preserves Unicode and rejects modified chunks',async()=>{
  const files=new Map(),fetcher=async(url,options={})=>{
    if(String(url)==='/api/files/upload'){const p=JSON.parse(options.body),path=`/user/files/${p.name}`;files.set(path,Buffer.from(p.data,'base64').toString('utf8'));return Response.json({path});}
    const path=new URL(url,'http://localhost/').pathname;return files.has(path)?new Response(files.get(path)):new Response('',{status:404});
  };
  const bridge=new TavernBridge(()=>({getRequestHeaders:()=>({})}),fetcher),data={format:'lantern-backup-v2',branch:{campaignId:'c',branchId:'b',payload:'😀情报'.repeat(180000)},records:[]};
  const pointer=await bridge.writeBackup(data);assert.equal(pointer.chunked,true);assert.deepEqual(await bridge.readBackup(pointer),data);const chunk=[...files.keys()].find(k=>k.includes('chunk'));files.set(chunk,'tampered');await assert.rejects(bridge.readBackup(pointer),/核对失败/);
});
test('native 204 is accepted by extension branch switch transport',async()=>{
  const bridge=new TavernBridge(()=>({getRequestHeaders:()=>({})}),async()=>new Response(null,{status:204}));assert.equal(await bridge.http('/api/extensions/switch',{}),null);
});
