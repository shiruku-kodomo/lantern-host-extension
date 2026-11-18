import {applyRunOperation} from './opening.js';
import {ordinary} from './exact.js';

export function simpleInquiry(text){
  return /调查|询问|交谈|核实/.test(text)&&/只推进这一项|仅.*一次|先.*(?:询问|交谈)/.test(text)&&!/战斗|攻击|面板|数值|提示词|设置/.test(text);
}
export function explicitRandomRequest(text){
  return String(text).split(/[。！？\n]/).some(part=>/(?:突发|随机)事件/.test(part)&&/抽|触发|来一|来个|生成|实际|现在|请求/.test(part)&&!/(?:不要|不用|不需|禁止|取消|别).{0,12}(?:突发|随机)事件|解释|设置|为什么|如何|规则是什么|机制是什么/.test(part));
}
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
  if(!args.id||!args.allies?.length||!args.enemies?.includes(args.majorEnemyId)||!args.basis?.trim()||args.rounds?.length!==5)throw new Error('五次交锋块需固定身份、双方、主要敌人、依据及五项战前行动。');
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
