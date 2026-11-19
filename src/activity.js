// User-facing progress is projected from recorded operations, never invented model reasoning.
const ROLES={host:'主持',judgment:'判定',analysis:'分析',intelligence:'情报',character:'历史角色记录'};
const OPERATIONS={
  'definition.create':'保存内容定义','entity.create':'建立人物档案','entity.configure':'补齐人物参数','entity.outcome':'登记战斗去向',
  'relationship.daily':'结算日常互动','relationship.propose':'进行提议判定','cooperation.accept':'登记正式合作',
  'narration.select':'切换叙述者','companion.select':'调整同行安排','form.switch':'切换形态','skill.use':'使用技能',
  'effect.apply':'施加状态','effect.expire':'解除状态','item.acquire':'登记获得物品','item.transfer':'转交物品','item.use':'使用物品','item.equip':'调整装备',
  'knowledge.record':'登记已知情报','knowledge.share':'记录情报传播','knowledge.resolve':'整理过渡线索',
  'ensure_entity':'建立角色档案','execute_actions':'批量执行行动',
  'quest.create':'建立任务','quest.board':'生成任务板','quest.accept':'接取任务','quest.progress':'更新任务进度','quest.finish':'结算任务奖励',
  'combat.start':'建立战斗判定块','combat.exchange':'执行战斗交锋','combat.finish':'结算战斗结果','combat.phase':'承接Boss下一阶段',
  'growth.victory':'结算胜利成长','growth.defeat':'结算正式败北','time.advance':'推进游戏时间','rest.recover':'结算休整恢复',
  'scene.update':'更新场景','world.register':'登记世界实体','world.progress':'检查世界阶段',
  'identity.observe':'登记身份识别','random.event':'判定本轮随机事件',
};
const compact=(text,max=110)=>{const value=String(text??'').replace(/\s+/g,' ').trim();return value.length>max?`${value.slice(0,max)}…`:value;};
const roleName=role=>ROLES[role]||'主持';
const fileName=path=>String(path||'').split(/[\\/]/).at(-1)?.replace(/\.(md|txt|json)$/i,'')||'';
function readableProgress(value){
  let text=String(value||'').trim();
  const candidate=text.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  if(/^[{[]/.test(candidate)){try{const data=JSON.parse(candidate);text=[data.public_summary,data.summary,data.message,data.text].find(v=>typeof v==='string')||'已完成本阶段处理。';}catch{text='已完成本阶段处理。';}}
  if(text.length<=360)return text;
  const prefix=text.slice(0,360),end=Math.max(prefix.lastIndexOf('。'),prefix.lastIndexOf('；'),prefix.lastIndexOf('\n\n'));
  return `${prefix.slice(0,end>100?end+1:360).trimEnd()}…`;
}
const doneStatus=status=>status==='failed'?'failed':['pending','interrupted'].includes(status)?'pending':status==='running'?'running':'complete';
export function toolPresentation(step){
  const p=step.parameters||{},r=step.result||{},state=doneStatus(step.status);
  let title='',detail='';
  switch(step.tool){
    case'delegate':title=`交给${roleName(p.role)} Agent`;detail=compact(p.task);break;
    case'read_state':title='读取本局记录';detail=r.entities?`${Object.keys(r.entities).length}名人物 · 状态版本 ${r.revision??0}`:'核对当前人物与实际记录';break;
    case'search_content':title='搜索游戏资料';detail=`${compact(p.query,80)}${Array.isArray(step.result)?` · 找到 ${step.result.length} 项`:''}`;break;
    case'read_content':title=`阅读${fileName(r.path)||r.title||'资料原文'}`;detail=r.path||'读取正式资料及来源版本';break;
    case'read_fields':title=`读取${fileName(r.path)||'正式'}数值`;detail=r.fields?`已核对 ${Object.keys(r.fields).length} 个正式字段`:`查询 ${p.paths?.length||0} 个字段`;break;
    case'read_rules':title='核对机制规则';detail=Array.isArray(step.result)?`已读取 ${step.result.length} 项规则及关联机制`:'读取本轮所需规则';break;
    case'roll_dice':title=`投掷 ${p.count||1}D${p.sides||20}`;detail=r.raw?`骰点 ${r.raw.join('、')} · 修正 ${r.modifierTotal>=0?'+':''}${r.modifierTotal} · 最终 ${r.total}${r.reused?' · 复用已存结果':''}`:compact(p.purpose);break;
    case'mechanism':title=OPERATIONS[p.type]||'执行游戏机制';
      if(r.alliedRoll&&r.enemyRoll)detail=`第${r.round}次交锋 · 我方 ${r.alliedRoll.raw.join('+')} ${r.alliedRoll.modifierTotal>=0?'+':'−'} ${Math.abs(r.alliedRoll.modifierTotal)} = ${r.alliedRoll.total}；对方 ${r.enemyRoll.total} · ${r.win?'我方胜':'对方胜'}`;
      else if(r.roll?.raw)detail=`骰点 ${r.roll.raw.join('、')} · 最终 ${r.roll.total}${typeof r.accepted==='boolean'?` · ${r.accepted?'接受':'拒绝'}`:''}`;
      else if(r.entity?.name)detail=`${r.entity.name}${r.reused?' · 使用已存档案':' · 已登记'}`;
      else if(r.knowledge)detail=`${r.knowledge.subjectLabel||'本局情报'} · ${r.knowledge.field||''}`;
      else if(r.before!==undefined&&r.after!==undefined)detail=`${compact(r.before,40)} → ${compact(r.after,40)}`;
      else if(r.wins!==undefined)detail=`五轮胜次 ${r.wins}/5 · ${({'victory':'获胜','defeat':'正式败北','phase-victory':'阶段突破','awaiting-choice':'等待下一选择'})[r.status]||r.status}`;
      else detail=compact(p.args?.basis||p.args?.name||'按正式规则执行并保存结果');break;
    case'ensure_entity':title='建立角色档案';detail=p.name?`${p.name} · 固定生成定义并保存`:'先固定定义，再建立实体';break;
    case'prepare_opening':title='保存开局档案';detail=r.completed?`玩家已登记 · ${r.questIds?.length||0}项待选任务 · 初始情报已保存`:'一次保存玩家、知情记录与任务板';break;
    case'execute_inquiry':title='执行本次询问';detail=r.interrupted?'到达期限或状态节点，等待下一选择':r.check?`D20 ${r.check.raw.join('+')} · 最终 ${r.check.total} · 记录已保存`:'固定行动条件后判定并保存';break;
    case'execute_combat_block':title='执行五次交锋';detail=r.completed?`五次交锋已保存 · 胜次 ${r.wins}/5`:'按预先声明执行真实交锋与必要后果';break;
    case'autoregister':title='登记正式角色';detail=`${r.name||'人物'} · 从原文登记面板与初始情报`;break;
    case'propose_plan':title='整理可执行计划';detail=r.plan?`${r.plan.steps.length}个步骤 · 等待你确认`:'列出目标、步骤和依赖';break;
    case'commit':title='保存本轮结算';detail=`状态版本 ${r.revision??''}${r.reused?' · 已有事件复用':' · 已提交'}`;break;
    case'worldbook':title='同步本局情报世界书';detail=step.error|| (r.skipped?'本轮没有新增需要注入的核心情报':`已核对投影版本 ${r.revision??''}`);break;
    default:title='处理本轮任务';detail=compact(p.task||'');
  }
  if(step.error)detail=compact(step.error,180);
  return{title,detail,state};
}
export function activityProjection(trace=[]){
  const items=[],steps=new Map(),pending=new Map(),usage=[];let group=null,lastAgent='host',request=null;
  const note=(key,agent,text,type='progress')=>{if(!text?.trim())return;items.push({kind:'note',key,agent,text,type});group=null;};
  const addStep=t=>{
    const signature=`${t.agent}:${t.tool}:${JSON.stringify(t.parameters||{})}`,existing=t.stepId?steps.get(t.stepId):t.status==='running'?null:pending.get(signature);
    if(existing){Object.assign(existing,t,{key:existing.key});if(t.status!=='running')pending.delete(signature);return;}
    if(!group||group.agent!==t.agent){group={kind:'group',key:`group:${t.id}`,agent:t.agent,steps:[]};items.push(group);}
    const step={...t,key:t.stepId||t.id};group.steps.push(step);steps.set(step.key,step);if(t.status==='running')pending.set(signature,step);
  };
  for(const t of trace){
    lastAgent=t.agent||lastAgent;
    if(t.kind==='agent'&&t.status==='running')note(t.id,t.agent,`${roleName(t.agent)}${t.agent==='host'?'正在处理这一轮':'接到任务'}：${compact(t.task,240)}`);
    else if(t.kind==='agent'&&t.status==='complete'&&t.agent!=='host')note(t.id,t.agent,t.summary);
    else if(t.kind==='commentary')note(t.id,t.agent,t.text,'commentary');
    else if(t.kind==='response'&&t.summary)note(t.id,t.agent,t.summary,'public-summary');
    else if(t.kind==='compaction')note(t.id,t.agent,t.status==='complete'?'已压缩较早过程，正式数值和原始记录保留。':'正在压缩较早过程。');
    else if(t.kind==='tool')addStep(t);
    else if(t.kind==='autoregister')addStep({...t,tool:'autoregister',parameters:{}});
    else if(['commit','worldbook'].includes(t.kind))addStep({...t,agent:'host',tool:t.kind,parameters:{}});
    if(t.kind==='request')request=t;else if(t.kind==='response'){usage.push({agent:t.agent,input:t.usage?.prompt_tokens??t.usage?.input_tokens??t.usage?.promptTokenCount??t.inputTokens,output:t.usage?.completion_tokens??t.usage?.output_tokens??t.usage?.candidatesTokenCount,estimated:!t.usage,capacity:request?.capacity});request=null;}
  }
  const timing={model:trace.filter(t=>t.kind==='response').reduce((n,t)=>n+(t.durationMs||0),0),tools:trace.filter(t=>t.kind==='tool'&&t.status==='complete'&&t.tool!=='delegate').reduce((n,t)=>n+(t.durationMs||0),0),save:trace.filter(t=>['commit','worldbook'].includes(t.kind)).reduce((n,t)=>n+(t.durationMs||0),0)};
  const active=[...steps.values()].reverse().find(s=>s.status==='running'),latest=items.at(-1);
  return{items,active,request,lastAgent,latest,usage,timing,toolCount:[...steps.values()].filter(s=>s.status==='complete'&&!['commit','worldbook'].includes(s.tool)).length};
}
function element(tag,className,text){const e=document.createElement(tag);if(className)e.className=className;if(text!==undefined)e.textContent=text;return e;}
function setText(node,text){if(node.textContent!==text)node.textContent=text;}
function remember(details,state,key,defaultOpen){details.open=state.open.has(key)?state.open.get(key):defaultOpen;details.ontoggle=()=>{state.open.set(key,details.open);};}
function place(parent,child,index){if(parent.children[index]!==child)parent.insertBefore(child,parent.children[index]||null);}
function renderStep(node,step,state){
  if(!node){node=element('div','lh-tool-step');node.dataset.viewKey=`step:${step.key}`;
    const summary=element('div','lh-tool-step-summary');summary.append(element('span','lh-operation-icon'),element('span','lh-operation-label'),element('span','lh-operation-status'));node.append(summary);
  }
  const presentation=toolPresentation(step);node.dataset.status=presentation.state;
  setText(node.querySelector('.lh-operation-icon'),presentation.state==='running'?'◌':presentation.state==='failed'?'!':'✓');
  setText(node.querySelector('.lh-operation-label'),`${presentation.title}${presentation.detail?` · ${presentation.detail}`:''}`);
  node.querySelector('.lh-operation-label').title=`${presentation.title}${presentation.detail?` · ${presentation.detail}`:''}`;
  setText(node.querySelector('.lh-operation-status'),{running:'进行中',complete:'',failed:'未完成',pending:'待同步'}[presentation.state]);
  return node;
}
export function renderActivity(container,message,{state,markdown}){
  state.open??=new Map();const projected=activityProjection(message.trace||[]);
  if(!container._parts){const status=element('div','lh-activity-status');status.append(element('span','lh-activity-indicator'),element('span','lh-activity-status-text'));
    const follow=element('button','lh-activity-follow','查看最新进展');follow.type='button';follow.onclick=()=>{state.follow=true;const log=container.closest('.lh-messages');if(log)log.scrollTop=log.scrollHeight;follow.hidden=true;};status.append(follow);
    container.addEventListener('click',event=>{if(event.isTrusted&&event.target.closest('summary'))state.follow=false;});
    const list=element('div','lh-activity-feed'),usage=element('details','lh-activity-usage');usage.append(element('summary','','上下文与用量'),element('div','lh-activity-usage-content'));container.append(status,list,usage);remember(usage,state,'usage',false);container._parts={status,list,nodes:new Map(),usage};}
  const{status,list,nodes}=container._parts;
  const running=message.status==='running',active=projected.active;
  status.querySelector('.lh-activity-follow').hidden=!running||state.follow!==false;
  status.dataset.running=String(running);
  setText(status.querySelector('.lh-activity-status-text'),running?active?`${roleName(active.agent)} · ${toolPresentation(active).title}`:`${roleName(projected.request?.agent||projected.lastAgent)}正在整理结果…`:`${message.status==='failed'?'本轮在这里暂停':message.status==='cancelled'?'本轮已停止':'本轮处理记录'} · ${projected.toolCount}项操作${message.commit?' · 结算已保存':''}`);
  const timing=projected.timing;if(timing.model||timing.tools||timing.save)status.querySelector('.lh-activity-status-text').textContent+=` · 模型 ${(timing.model/1000).toFixed(1)}秒 · 工具 ${(timing.tools/1000).toFixed(1)}秒 · 保存同步 ${(timing.save/1000).toFixed(1)}秒`;
  const present=new Set();
  projected.items.forEach((item,index)=>{
    present.add(item.key);let node=nodes.get(item.key);
    if(item.kind==='note'){
      if(!node){node=element('div','lh-progress-note');node.dataset.viewKey=item.key;node.append(element('div','lh-progress-note-text'));nodes.set(item.key,node);}
      node.dataset.role=item.agent||'host';const text=node.querySelector('.lh-progress-note-text');
      const display=readableProgress(item.text);
      if(node._text!==display){markdown(text,display);node._text=display;}
    }else{
      if(!node){node=element('details','lh-tool-group lh-timeline');node.dataset.viewKey=item.key;node.append(element('summary','lh-tool-group-heading'),element('div','lh-tool-group-list'));node._steps=new Map();nodes.set(item.key,node);remember(node,state,item.key,running);}
      const completed=item.steps.filter(s=>s.status==='complete').length,failed=item.steps.some(s=>s.status==='failed'),inProgress=item.steps.some(s=>s.status==='running');
      setText(node.querySelector(':scope > summary'),`${roleName(item.agent)} · ${inProgress?'正在执行工具':failed?'操作需要处理':`已完成${completed}项操作`}`);
      const body=node.querySelector('.lh-tool-group-list');item.steps.forEach((step,i)=>{const entry=renderStep(node._steps.get(step.key),step,state);node._steps.set(step.key,entry);place(body,entry,i);});
    }
    place(list,node,index);
  });
  for(const[key,node]of nodes)if(!present.has(key)){node.remove();nodes.delete(key);}
  const usageBox=container._parts.usage;usageBox.hidden=!projected.usage.length;
  const content=usageBox.querySelector('.lh-activity-usage-content');
  if(usageBox.open){const lines=projected.usage.map((u,i)=>`${i+1}. ${roleName(u.agent)} · 输入${u.estimated?'估算':''} ${u.input??'未知'}${u.capacity?` / ${u.capacity}`:''}${u.output!==undefined?` · 回复 ${u.output}`:''} Token`);setText(content,lines.join('\n'));}
  usageBox.ontoggle=()=>{state.open.set('usage',usageBox.open);if(usageBox.open)setText(content,projected.usage.map((u,i)=>`${i+1}. ${roleName(u.agent)} · 输入${u.estimated?'估算':''} ${u.input??'未知'}${u.capacity?` / ${u.capacity}`:''}${u.output!==undefined?` · 回复 ${u.output}`:''} Token`).join('\n'));};
}
