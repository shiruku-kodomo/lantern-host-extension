import test from 'node:test';
import assert from 'node:assert/strict';
import {activityProjection,toolPresentation} from '../src/activity.js';

test('progress merges start and completion into a single stable operation and preserves interleaved notes',()=>{
  const trace=[{id:'a',kind:'agent',agent:'host',task:'分析本轮',status:'running'},
    {id:'b',kind:'tool',stepId:'host:delegate',agent:'host',tool:'delegate',parameters:{role:'analysis',task:'查人物'},status:'running'},
    {id:'c',kind:'agent',agent:'analysis',task:'查人物',status:'running'},
    {id:'d',kind:'tool',stepId:'analysis:read',agent:'analysis',tool:'read_fields',parameters:{id:'doc',paths:['hp']},status:'running'},
    {id:'e',kind:'tool',stepId:'analysis:read',agent:'analysis',tool:'read_fields',parameters:{id:'doc',paths:['hp']},result:{path:'角色/柠彩莲.md',fields:{hp:{value:100}}},status:'complete'},
    {id:'f',kind:'agent',agent:'analysis',summary:'已核对正式面板。',status:'complete'},
    {id:'g',kind:'tool',stepId:'host:delegate',agent:'host',tool:'delegate',parameters:{role:'analysis',task:'查人物'},result:{agent:'analysis'},status:'complete'}];
  const projected=activityProjection(trace),groups=projected.items.filter(i=>i.kind==='group');assert.equal(groups.length,2);assert.equal(groups[0].steps.length,1);assert.equal(groups[0].steps[0].status,'complete');assert.equal(groups[1].steps.length,1);assert.equal(groups[1].steps[0].key,'analysis:read');assert.equal(projected.toolCount,2);assert.equal(projected.active,undefined);assert.ok(projected.items.some(i=>i.kind==='note'&&i.text==='已核对正式面板。'));
  assert.equal(toolPresentation(groups[1].steps[0]).title,'读取柠彩莲数值');assert.equal(JSON.stringify(toolPresentation(groups[1].steps[0])).includes('"value"'),false);
});
test('legacy traces merge repeated lifecycle records and expose genuine dice and failure summaries',()=>{
  const start={id:'1',kind:'tool',agent:'judgment',tool:'roll_dice',parameters:{id:'roll',purpose:'检定',sides:20,count:1},status:'running'};
  const end={...start,id:'2',status:'complete',result:{raw:[14],modifierTotal:4,total:18,reused:true}};
  const p=activityProjection([start,end]);assert.equal(p.items[0].steps.length,1);assert.match(toolPresentation(p.items[0].steps[0]).detail,/14.*18.*复用/);
  assert.equal(toolPresentation({...end,status:'failed',error:'CHECK_CONFLICT'}).detail,'CHECK_CONFLICT');
});
