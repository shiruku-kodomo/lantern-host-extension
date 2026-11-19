// Versioned runtime migration. Historical input, events and dice remain audit records.
export const WORLD_VERSION=2;
export function migratePlan(plan){if(plan&&['pending','executing'].includes(plan.status))for(const step of plan.steps||[])if(step.agent==='character')step.agent='host';return plan;}
export const RETIRED_OPERATIONS=new Set(['route.create','movement.travel','currency.transfer','currency.quote','currency.trade','quest.pay']);
export function migrateWorld(world){
  if(!world)return world;
  delete world.routes;delete world.journeys;delete world.quotes;
  for(const e of Object.values(world.entities||{}))delete e.wallet;
  for(const d of Object.values(world.definitions||{})){if(d.fields)for(const k of ['wallet','basePrice','currency','priceMultiplier'])delete d.fields[k];if(d.fieldSources)for(const k of ['wallet','basePrice'])delete d.fieldSources[k];}
  for(const q of Object.values(world.quests||{})){delete q.reward;delete q.paid;delete q.payer;}
  world.version=WORLD_VERSION;return world;
}
export function migrateRecord(store,value){
  if(!value)return value;
  if(store==='branches'){migrateWorld(value.world);for(const message of [...(value.session?.messages||[]),...(value.session?.conversation?.nodes||[])])migratePlan(message.plan);}
  if(store==='plans')migratePlan(value);
  if(store==='snapshots'){migrateWorld(value.world);migrateWorld(value.after);}
  if(store==='entities')delete value.wallet;
  if(store==='definitions'){if(value.fields)for(const k of ['wallet','basePrice','currency','priceMultiplier'])delete value.fields[k];if(value.fieldSources)for(const k of ['wallet','basePrice'])delete value.fieldSources[k];}
  if(store==='quests'){delete value.reward;delete value.paid;delete value.payer;}
  if(store==='runs'){
    migrateWorld(value.before);migrateWorld(value.world);
    migratePlan(value.plan);
    if(!['complete','committed'].includes(value.status)){
      value.cancelledOperations??=[];
      value.operations=(value.operations||[]).filter(op=>{if(!RETIRED_OPERATIONS.has(op.type))return true;if(!value.cancelledOperations.some(o=>o.id===op.id))value.cancelledOperations.push({...op,status:'cancelled',reason:'货币和移动机制已移除'});return false;});
      for(const conversation of Object.values(value.conversations||{})){
        for(const message of [...conversation])for(const call of message.tool_calls||[]){let args;try{args=JSON.parse(call.function.arguments);}catch{continue;}
          if(call.function.name==='execute_actions'&&Array.isArray(args.operations)){
            const removed=args.operations.filter(op=>RETIRED_OPERATIONS.has(op.type));if(!removed.length)continue;
            for(const op of removed)if(!value.cancelledOperations.some(o=>o.id===op.id))value.cancelledOperations.push({...op,status:'cancelled',reason:'货币和移动机制已移除'});
            args.operations=args.operations.filter(op=>!RETIRED_OPERATIONS.has(op.type));call.function.arguments=JSON.stringify(args);delete value.receipts?.[`${Object.keys(value.conversations).find(k=>value.conversations[k]===conversation)}:${call.id}`];
            if(args.operations.length)continue;
          }else if(!RETIRED_OPERATIONS.has(args?.type))continue;
          const reply=conversation.find(m=>m.role==='tool'&&m.tool_call_id===call.id),content=JSON.stringify({cancelled:true,reason:'该货币或移动操作已经废弃；场景和报酬交由主持描述，不调用替代扣费或路线工具。'});
          if(reply)reply.content=content;else conversation.push({role:'tool',tool_call_id:call.id,content});
        }
      }
    }
  }
  return value;
}
