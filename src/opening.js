import {stable} from './game-db.js';

export async function applyRunOperation(run, engine, operation) {
  const previous=run.operations.find(o=>o.id===operation.id);
  if(previous){
    if(stable(previous)!==stable(operation))throw new Error('OPERATION_CONFLICT：已固定操作的参数不能更改。');
    return run.operationResults?.[operation.id];
  }
  const applied=await engine.execute(run.world,operation);
  run.world=applied.world;if(operation.type==='entity.create'&&applied.result.entity){run.turnStartAffection??={};run.turnStartAffection[applied.result.entity.id]??=applied.result.entity.affection;}run.operations.push(operation);
  run.operationResults??={}; run.operationResults[operation.id]=applied.result;
  return applied.result;
}

export async function ensureEntity(run, engine, args, input) {
  if(!args.id||!args.name||!args.reason||!args.basis)throw new Error('人物需固定ID、姓名、生成原因与依据。');
  const existing=run.world.entities[args.id]||Object.values(run.world.entities).find(e=>e.name===args.name);
  if(existing?.forms)return {entity:existing,definition:run.world.definitions[existing.definitionId],created:false,reused:true};
  const entityId=existing?.id||args.id, definitionId=args.definition?.id||`generated:${entityId}`;
  const forms=args.definition?.fields?.forms;
  if(!forms||!Object.keys(forms).length)throw new Error('definition.fields.forms 需一次提供完整面板。');
  for(const [form,panel] of Object.entries(forms))for(const field of ['hp','mp','attack','defense','speed'])if(!Number.isSafeInteger(panel?.[field])||panel[field]<1)throw new Error(`definition.fields.forms.${form}.${field} 必须为大于0的整数，当前为 ${panel?.[field]}。`);
  const definition={...structuredClone(args.definition),id:definitionId,name:args.name,type:'character',origin:'generated',source:{kind:'player',quote:input},generationReason:args.reason};
  const definitionResult=await applyRunOperation(run,engine,{id:`${entityId}:definition`,type:'definition.create',args:definition});
  const operation=existing
    ? {id:`${entityId}:configure`,type:'entity.configure',args:{entityId,definitionId,basis:args.basis}}
    : {id:`${entityId}:entity`,type:'entity.create',args:{id:entityId,definitionId,kind:args.kind||'character',location:args.location||null}};
  const entityResult=await applyRunOperation(run,engine,operation);
  return {entity:entityResult.entity,definition:definitionResult.definition,created:!existing,configured:!!existing};
}

export async function prepareOpening(run, engine, args, input) {
  if(!run.opening)throw new Error('当前不是需要初始化的开局；请使用具体机制推进。');
  if(run.world.opening?.completed)return {...run.world.opening,reused:true};
  if(!args.player&&!args.quests?.length)throw new Error('请提供玩家档案或三个任务候选；已经保存的部分不需重交。');
  if(args.quests?.length&&args.quests.length!==3)throw new Error('任务板需要三个候选。');
  for(const quest of args.quests||[])if(!quest.hiddenFailure?.trim())throw new Error('每项候选需在投骰前固定可能的失败事实 hiddenFailure。');
  const staged=structuredClone(run); const result={...run.world.opening,completed:false};
  if(args.player){
    const player=await ensureEntity(staged,engine,{...args.player,id:'player',kind:'player',location:args.player.location||staged.opening.location},input);
    result.playerId=player.entity.id;
    const known=[player.entity.id,...(args.player.acquaintance?staged.opening.targetIds:[])];
    await applyRunOperation(staged,engine,{id:'opening:player-identity',type:'knowledge.record',args:{id:'opening:player-identity',subjectId:player.entity.id,field:'身份与相识经过',value:{name:player.entity.name,identity:args.player.identity||'',acquaintance:args.player.acquaintance||''},knowers:known,status:'verified',source:args.player.basis}});
  }
  if(args.quests?.length){
    const ids=[];
    for(let i=0;i<args.quests.length;i++){
      const quest={...args.quests[i],id:`opening:quest:${i+1}`}; ids.push(quest.id);
      await applyRunOperation(staged,engine,{id:quest.id,type:'quest.create',args:quest});
    }
    await applyRunOperation(staged,engine,{id:'opening:quest-board',type:'quest.board',args:{questIds:ids}});
    result.questIds=ids;
  }
  const needsPlayer=staged.opening.needsPlayer&&!staged.world.entities.player?.forms,needsQuests=staged.opening.needsQuests&&!result.questIds?.length;
  result.completed=!needsPlayer&&!needsQuests;result.pendingFields=[...(needsPlayer?['player']:[]),...(needsQuests?['quests']:[])];
  staged.world.opening=result; staged.opening={...staged.opening,...result,needsPlayer,needsQuests};
  Object.assign(run,{world:staged.world,operations:staged.operations,operationResults:staged.operationResults,opening:staged.opening});
  run.world.nextStop=result.completed?'玩家选择任务；尚未接受或执行任何任务。':`继续补齐开局：${result.pendingFields.join('、')}；已保存部分直接复用。`;
  return {...result,player:result.playerId?run.world.entities[result.playerId]:undefined,quests:(result.questIds||[]).map(id=>{const q=run.world.quests[id];return {id:q.id,name:q.name,goal:q.goal,location:q.location,level:q.level};}),nextStop:run.world.nextStop};
}
