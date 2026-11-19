const statuses={victory:'本方获胜',defeat:'正式败北','awaiting-choice':'等待下一行动选择','phase-victory':'阶段突破，尚未最终胜利',active:'进行中',offered:'待选择',complete:'已完成',failed:'失败'};
const eventNames={none:'没有突发事件',supply:'补给事件',intelligence:'情报事件',minor:'一般事件','troop-1':'一名兵种遭遇','troop-2':'两名兵种遭遇','troop-3':'三名兵种遭遇','elite-1-troop-1':'精英与兵种遭遇','elite-1-troop-2':'精英与两名兵种遭遇','eligible-boss-or-elite-1-troop-3':'Boss或混合遭遇候选',setback:'挫折事件','high-risk-choice':'高风险选择','direct-defeat':'直接败北事件'};
const value=v=>v&&typeof v==='object'&&'n'in v?Number(v.d)===1?String(v.n):`${v.n}/${v.d}`:typeof v==='object'?Object.entries(v||{}).map(([k,x])=>`${k}：${value(x)}`).join('；'):String(v??'');
export function completedTurnSummary(run){
 const lines=['## 本轮已执行结果'];
 const changed=new Set(run.operations.map(op=>op.type));
 if(changed.has('quest.board'))for(const q of Object.values(run.world.quests).filter(q=>q.status==='offered'))lines.push(`- 候选任务「${q.name}」：${q.goal}。尚未接取。`);
 if(changed.has('quest.accept')||changed.has('quest.progress')||changed.has('quest.finish'))for(const q of Object.values(run.world.quests))if(run.operations.some(op=>op.args?.questId===q.id))lines.push(`- 任务「${q.name}」：${statuses[q.status]||q.status}。`);
 for(const b of Object.values(run.world.battles))if(run.operations.some(op=>op.args?.battleId===b.id||op.type==='combat.start'&&op.args?.id===b.id)){
   lines.push(`- 战斗：${b.rounds.length}次真实对抗，我方胜${b.wins??b.rounds.filter(r=>r.win).length}次；${statuses[b.status]||b.status}。`,'','| 轮次 | 我方骰点→总值 | 敌方骰点→总值 | 结果 |','| --- | --- | --- | --- |');
   for(const r of b.rounds)lines.push(`| ${r.round} | ${r.alliedRoll.raw.join('、')}→${r.alliedRoll.total} | ${r.enemyRoll.raw.join('、')}→${r.enemyRoll.total} | ${r.win?'胜':'负'} |`);
 }
 const entityIds=new Set(run.operations.flatMap(op=>[op.args?.entityId,...op.args?.allies||[],...op.args?.entities||[]]).filter(Boolean));
 for(const id of entityIds){const e=run.world.entities[id];if(!e)continue;if(e.forms)lines.push(`- ${e.name}：${e.form==='transformed'?'变身':'当前'}状态，HP ${value(e.hp)}，MP ${value(e.mp)}${e.defeats?`，败北次数${e.defeats}`:''}。`);else if(e.location)lines.push(`- ${e.name}：${e.location}。`);}
 for(const op of run.operations){const r=run.operationResults?.[op.id];if(op.type==='knowledge.record'&&r?.knowledge){const k=r.knowledge;lines.push(`- 已登记情报（仅${k.knowers.map(id=>run.world.entities[id]?.name||id).join('、')}知情）：${k.subjectLabel||run.world.entities[k.subjectId]?.name||k.subjectId}／${k.field}：${value(k.value)}。`);}if(op.type==='random.event'&&r)lines.push(`- 突发事件：真实骰点${r.roll.raw.join('、')}，修正后${r.roll.total}；${eventNames[r.category]||r.category}。`);}
 if(lines.length===1)lines.push(`- 已完成${run.operations.length}项实际操作，详细结果见本轮工具记录。`);
 if(run.finishRequested?.note)lines.push('\n## 正文交接要求',run.finishRequested.note);
 lines.push('\n下一停点：'+run.world.nextStop);return lines.join('\n');
}
