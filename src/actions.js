import {applyRunOperation} from './opening.js';
import {ordinary} from './exact.js';

export async function executeInquiry(run,engine,args,input,checkpoint=async()=>{}){
  if(run.inquiry?.completed)return {...run.inquiry,reused:true};
  if(!args.purpose?.trim()||!args.actors?.length||!args.subjectId||!args.success?.trim()||!args.failure?.trim())throw new Error('询问需预先明确行动、参与者、对象与成败分支。');
  if(!Number.isSafeInteger(args.minutes)||args.minutes<1||args.minutes>120)throw new Error('询问耗时需预先确定为1—120分钟。');
  for(const id of args.actors)if(!run.world.entities[id])throw new Error(`人物未建档：${id}`);
  const signature=JSON.stringify(args);
  if(run.inquiry?.signature&&run.inquiry.signature!==signature)throw new Error('ACTION_CONFLICT：已固定的询问条件不能见骰后更改。');
  run.inquiry={signature};
  await checkpoint();
  const staged=structuredClone(run);
  const active=Object.values(staged.world.quests).find(q=>q.status==='active');
  const modifiers=[];
  if(active?.doomed)modifiers.push({source:'已固定必败任务的有利行动修正',value:-10});
  const time=await applyRunOperation(staged,engine,{id:'inquiry:time',type:'time.advance',args:{minutes:args.minutes,basis:args.purpose}});
  if(time.remaining>0){const result={completed:true,signature,interrupted:true,elapsedMinutes:staged.world.time-run.world.time,nextStop:'调查在期限或状态节点中断，尚未获得调查结果，等待下一选择。'};staged.world.nextStop=result.nextStop;Object.assign(run,{world:staged.world,operations:staged.operations,operationResults:staged.operationResults,inquiry:result});return result;}
  const check=await engine.dice(`${run.id}:inquiry:check`,{sides:20,count:1,purpose:args.purpose,modifiers});
  const outcome=ordinary(check),success=outcome==='success'||outcome==='critical-success',observation=success?args.success:args.failure;
  await applyRunOperation(staged,engine,{id:'inquiry:knowledge',type:'knowledge.record',args:{id:`${run.userId}:inquiry`,subjectId:args.subjectId,subjectLabel:args.subjectLabel||args.subjectId,field:'本次询问记录',value:observation,knowers:args.actors,status:success?'rumor':'observation',source:`现场询问；${check.id}；${outcome}`,basis:args.purpose}});
  staged.world.nextStop='本次询问已完成，等待玩家选择下一行动。';
  Object.assign(run,{world:staged.world,operations:staged.operations,operationResults:staged.operationResults,inquiry:{completed:true,signature,check,outcome,observation,elapsedMinutes:staged.world.time-run.world.time,nextStop:staged.world.nextStop}});
  return run.inquiry;
}

export async function executeCombatBlock(run,engine,args,checkpoint=async()=>{}){
  if(run.combatBlock?.completed)return {...run.combatBlock,reused:true};
  // An existing declaration must keep the original dice purposes and signatures on resume.
  const fixed=run.combatBlock?.signature?JSON.parse(run.combatBlock.signature):null;
  const overrideRounds=new Set();for(const row of args.roundOverrides||[]){if(!Number.isInteger(row.round)||row.round<1||row.round>5||overrideRounds.has(row.round))throw new Error('单轮覆盖需使用不重复的1—5轮号。');overrideRounds.add(row.round);}
  const declaration={...args,rounds:args.rounds||fixed?.rounds||Array.from({length:5},(_,i)=>({action:'战斗对抗',attackerSide:args.attackerSide||'allies',defenseField:args.defenseField||'defense',...(args.roundOverrides||[]).find(r=>r.round===i+1)}))};
  args=declaration;
  if(!args.id||!args.allies?.length||!args.enemies?.includes(args.majorEnemyId)||!args.basis?.trim()||args.rounds?.length!==5)throw new Error('五次对抗需固定身份、双方、主要敌人及判定依据。');
  for(const round of args.rounds)round.action??='战斗对抗';
  for(const round of args.rounds)if(!round.action?.trim()||!['allies','enemies'].includes(round.attackerSide)||!['defense','speed'].includes(round.defenseField))throw new Error('每次交锋必须在投骰前确定行动、攻守方和对抗属性。');
  const signature=JSON.stringify(args);if(run.combatBlock?.signature&&run.combatBlock.signature!==signature)throw new Error('ACTION_CONFLICT：已开始的交锋声明不可见骰后修改。');
  run.combatBlock={signature};await checkpoint();const staged=structuredClone(run),prefix=`block:${args.id}`;
  for(const change of args.formSwitches||[])await applyRunOperation(staged,engine,{id:`${prefix}:form:${change.entityId}`,type:'form.switch',args:{entityId:change.entityId,form:change.form,basis:args.basis}});
  await applyRunOperation(staged,engine,{id:`${prefix}:start`,type:'combat.start',args:{id:args.id,allies:args.allies,enemies:args.enemies,majorEnemyId:args.majorEnemyId,basis:args.basis}});
  for(let index=0;index<5;index++)await applyRunOperation(staged,engine,{id:`${prefix}:round:${index+1}`,type:'combat.exchange',args:{...args.rounds[index],battleId:args.id,round:index+1}});
  const result=await applyRunOperation(staged,engine,{id:`${prefix}:finish`,type:'combat.finish',args:{battleId:args.id}});
  for(const id of args.allies)if(staged.world.entities[id].formalDefeat)await applyRunOperation(staged,engine,{id:`${prefix}:defeat:${id}`,type:'growth.defeat',args:{entityId:id}});
  const output={completed:true,signature,...result,rounds:staged.world.battles[args.id].rounds,participants:args.allies.map(id=>{const e=staged.world.entities[id];return {id,name:e.name,form:e.form,hp:e.hp,mp:e.mp,defeats:e.defeats};}),nextStop:staged.world.nextStop};
  Object.assign(run,{world:staged.world,operations:staged.operations,operationResults:staged.operationResults,combatBlock:output});return output;
}

export async function executeActions(run,engine,args,checkpoint=async()=>{},normalize=async op=>op){
  if(!Array.isArray(args.operations)||!args.operations.length)throw new Error('需提供本轮已经确定的操作。');
  const ids=new Set();for(const op of args.operations){if(!op.id||ids.has(op.id)||!op.type||!op.args)throw new Error('批量操作需唯一ID、类型及参数。');ids.add(op.id);}
  const results=[];
  for(const raw of args.operations){const op=await normalize(raw),result=await applyRunOperation(run,engine,op);results.push({id:op.id,type:op.type,result:compactResult(result)});await checkpoint();}
  return {completed:true,results,nextStop:run.world.nextStop};
}
export function compactResult(value){
  if(!value||typeof value!=='object')return value;
  if(Array.isArray(value))return value.map(compactResult);
  return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,key==='source'&&v&&typeof v==='object'?Object.fromEntries(Object.entries(v).filter(([k])=>!['quote','initialSnapshot'].includes(k))):compactResult(v)]));
}
