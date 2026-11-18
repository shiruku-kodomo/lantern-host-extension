import { branchKey, digest, stable } from './game-db.js';
export function projectKnowledge(world) {
  const needed = new Set(Object.values(world.quests).filter(q=>['active','offered'].includes(q.status)).flatMap(q=>q.knowledgeIds||[]));
  const records=Object.values(world.knowledge).filter(k=>(k.active!==false||needed.has(k.id))&&(!['falsified','outdated'].includes(k.status)||needed.has(k.id))&&(k.canonical||!k.resolved||needed.has(k.id)));
  const groups=new Map();
  for(const k of records){const key=stable([k.subjectId,k.field,k.value,k.status,k.source,k.validity]);const g=groups.get(key)||{...k,knowers:[]};g.knowers=[...new Set([...g.knowers,...k.knowers])];groups.set(key,g);}
  const status={rumor:'传闻',observation:'观察',inference:'推测',verified:'已核实',outdated:'已过时',falsified:'已证伪'};
  const lines=['以下分组仅说明各人物实际知情，不代表角色之间共享信息。人物只能使用自己组内的知识；原始后台设定不得自动视为角色已知。'];
  const characters=Object.values(world.entities).filter(e=>[...groups.values()].some(k=>k.knowers.includes(e.id)));
  for(const e of characters){lines.push(`\n【${e.name}｜${e.id} 已知】`);for(const k of groups.values())if(k.knowers.includes(e.id))lines.push(`- ${k.subjectLabel||k.subjectId} · ${k.field}：${typeof k.value==='string'?k.value:JSON.stringify(k.value)}［${status[k.status]||k.status}；来源：${typeof k.source==='string'?k.source:JSON.stringify(k.source)}；时间：${k.at}；${k.validity||'当前有效'}］`);}
  return{content:lines.join('\n'),hasCore:records.some(k=>k.canonical),count:groups.size};
}
export class WorldbookProjection {
  constructor(bridge,store,db){Object.assign(this,{bridge,store,db});}
  async ensureInitial(campaignId,key){
    const campaign=await this.store.read('campaigns',campaignId)||{id:campaignId};
    if(campaign.initialWorld!==undefined)return campaign;
    if(this.bridge.key()!==key)throw new Error('聊天已切换。');
    let name=this.bridge.context().chatMetadata.world_info||null,data=null;
    if(name){data=await this.bridge.http('/api/worldinfo/get',{name});const owner=data.extensions?.lanternHost;
      if(owner){name=owner.initialName||null;data=owner.initialSnapshot||null;}}
    campaign.initialWorld={name,snapshot:data,version:data?await digest(data):null};
    await this.store.write('campaigns',campaignId,campaign);return campaign;
  }
  async sync(campaignId,branchId,key){
    const branch=await this.db.get(campaignId,branchId),campaign=await this.ensureInitial(campaignId,key),projection=projectKnowledge(branch.world);
    const pendingKey=`world:${branchKey(campaignId,branchId)}`;
    if(!branch.worldbook&&!projection.hasCore){
      const current=this.bridge.context().chatMetadata.world_info;
      if(current&&current!==campaign.initialWorld.name){const book=await this.bridge.http('/api/worldinfo/get',{name:current});if(book.extensions?.lanternHost)await this.bridge.bindWorld(key,campaign.initialWorld.name||'');}
      return{revision:branch.world.revision,skipped:true};
    }
    await this.store.write('outbox',pendingKey,{campaignId,branchId,type:'worldbook',revision:branch.world.revision});
    const name=branch.worldbook?.name||`灯火-本局-${campaignId}-${branchId}`;
    const all=await this.bridge.http('/api/worldinfo/list',{}),exists=all.some(b=>(b.name||b.file_id)===name);
    let book=exists?await this.bridge.http('/api/worldinfo/get',{name}):structuredClone(campaign.initialWorld.snapshot||{entries:{}});
    // User entries from an inherited branch are retained; only owned entries are replaced.
    for(const [uid,e]of Object.entries(book.entries||{}))if(e.extensions?.lanternHost)delete book.entries[uid];
    book.entries??={};book.extensions??={};
    if(exists&&book.extensions.lanternHost?.campaignId!==campaignId)throw new Error('同名世界书属于其他来源，未覆盖。');
    const old=Object.values((exists?await this.bridge.http('/api/worldinfo/get',{name}):{}).entries||{}).find(e=>e.extensions?.lanternHost?.campaignId===campaignId);
    const uid=old?.uid??Math.max(0,...Object.values(book.entries).map(e=>Number(e.uid)||0))+1;
    book.entries[uid]={...(old||{}),uid,key:[],keysecondary:[],comment:'本局角色已知情报',content:projection.content,constant:true,selective:false,disable:false,position:4,role:0,depth:9999,order:100,probability:100,useProbability:true,preventRecursion:true,ignoreBudget:true,
      extensions:{...(old?.extensions||{}),lanternHost:{campaignId,branchId,projectionVersion:branch.world.revision,managed:true}}};
    book.extensions.lanternHost={campaignId,branchId,initialName:campaign.initialWorld.name,initialSnapshot:campaign.initialWorld.snapshot};
    await this.bridge.saveWorld(name,book);await this.bridge.bindWorld(key,name);
    const current=await this.db.get(campaignId,branchId);if(current.world.revision!==branch.world.revision)throw new Error('结算版本已更新，世界书需要继续同步。');
    const worldbook={name,uid,revision:branch.world.revision,hash:await digest(projection.content),count:projection.count};
    await this.store.atomic('branches',branchKey(campaignId,branchId),(latest,tx)=>{if(latest.world.revision!==branch.world.revision)throw new Error('情报版本已变化。');latest.worldbook=worldbook;tx.objectStore('branches').put(latest,branchKey(campaignId,branchId));tx.objectStore('outbox').delete(pendingKey);},['outbox']);return worldbook;
  }
}
