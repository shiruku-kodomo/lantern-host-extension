import {fraction as F} from './exact.js';
export const STATE_COLLECTIONS=['entities','definitions','items','knowledge','quests','battles','places','effects','claims','countries'];
function merge(target,fields){for(const [key,value]of Object.entries(fields)){if(['__proto__','constructor','prototype'].includes(key))continue;if(value&&typeof value==='object'&&!Array.isArray(value)&&target[key]&&typeof target[key]==='object'&&!Array.isArray(target[key]))merge(target[key],value);else target[key]=structuredClone(value);}return target;}
export function editState(world,args){
  const changes=[];
  for(const change of args.changes||[]){
    if(!STATE_COLLECTIONS.includes(change.collection)||!change.id)throw new Error('请指定现有记录类别和记录ID。');
    const collection=world[change.collection]??={},before=structuredClone(collection[change.id]??null);
    if(change.remove)delete collection[change.id];else{
      const record=merge(structuredClone(collection[change.id]||{id:change.id}),change.fields||{});
      if(change.collection==='entities')for(const key of ['hp','mp'])if(record[key]!==undefined)record[key]=F(record[key]);
      Object.defineProperty(collection,change.id,{value:record,enumerable:true,writable:true,configurable:true});
    }
    changes.push({collection:change.collection,id:change.id,before,after:structuredClone(collection[change.id]??null)});
  }
  if(args.nextStop!==undefined)world.nextStop=String(args.nextStop);
  if(args.scene!==undefined)world.scene=String(args.scene);
  if(args.time!==undefined)world.time=Number(args.time);
  return {changes,nextStop:world.nextStop,summary:args.summary||'已按主持决定更新记录'};
}
