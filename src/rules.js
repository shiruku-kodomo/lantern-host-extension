export const RULE_VERSION = '2026-11-19.2';
const catalog = {
  dice: ['骰子机制', []], relationship: ['好感度与提议机制', ['dice']], combat: ['战斗机制', ['dice','skill','effect','form','growth']],
  growth: ['成长与败北结算机制',['dice','form']], form: ['变身机制',['skill','effect','identity']], skill: ['技能机制',['effect','item']],
  effect: ['正负面状态机制',['form','time']], item: ['物品机制',['knowledge']], knowledge: ['调查与情报机制',[]], time: ['时间与休整机制',[]],
  quest: ['任务机制',['relationship','dice','knowledge','time']], random: ['突发事件机制',['dice','quest','troop','elite','boss','growth']],
  cooperation: ['角色解锁与正式合作机制',['relationship','knowledge']], narration: ['同行与叙述切换机制',['cooperation','relationship']],
  country: ['国家机制',['organization','boss']], city: ['城市机制',['country']],
  organization: ['组织机制',['outpost','boss']], troop: ['兵种机制',[]], elite: ['精英机制',['troop']], boss: ['Boss机制',['country']],
  outpost: ['据点机制',['troop','elite','boss']], identity: ['身份暴露与信誉机制',['knowledge']],
  reward: ['任务结算机制调整',['quest','growth','item','knowledge']],
};
export const RULES = Object.fromEntries(Object.entries(catalog).map(([id,[title,dependencies]])=>[id,{id,title,dependencies,version:RULE_VERSION}]));
export function ruleClosure(ids) { const all=new Set(); const visit=id=>{if(all.has(id))return;if(!RULES[id])throw new Error(`未知机制 ${id}`);all.add(id);RULES[id].dependencies.forEach(visit);};ids.forEach(visit);return [...all]; }
export const OP_RULE = {
  'entity.create':'cooperation','definition.create':'skill','relationship.daily':'relationship','relationship.propose':'relationship','cooperation.accept':'cooperation',
  'narration.select':'narration','companion.select':'narration','form.switch':'form','skill.use':'skill','effect.apply':'effect','effect.expire':'effect',
  'item.acquire':'item','item.transfer':'item','item.use':'item','knowledge.record':'knowledge','knowledge.share':'knowledge','knowledge.resolve':'knowledge',
  'item.equip':'item','entity.outcome':'troop',
  'entity.configure':'cooperation','scene.update':'knowledge',
  'combat.phase':'combat',
  'quest.create':'quest','quest.board':'quest','quest.accept':'quest','quest.progress':'quest','quest.finish':'reward',
  'combat.start':'combat','combat.exchange':'combat','combat.finish':'combat','growth.victory':'growth','growth.defeat':'growth',
  'time.advance':'time','rest.recover':'time','world.register':'country','world.progress':'organization',
  'identity.observe':'identity','random.event':'random',
};
export class ContentRegistry {
  constructor(library){this.library=library;this.loaded=new Map();this.ruleCache=new Map();}
  async search(query){return(await this.library.search(query)).slice(0,30).map(d=>({id:d.id,entityId:d.entityId,aliases:d.aliases,title:d.title,path:d.path,version:d.sha256,canonical:!d.imported}));}
  async fields(id,paths){const d=await this.read(id),available=d.fields||Object.fromEntries(Object.entries(d.structured).flatMap(([form,panel])=>Object.entries(panel).map(([field,value])=>[`forms.${form}.${field}`,{value,version:d.sha256}])));return{id:d.id,entityId:d.entityId,path:d.path,version:d.sha256,fields:Object.fromEntries((paths?.length?paths:Object.keys(available)).map(p=>{if(!available[p])throw new Error(`字段不存在：${p}。请读取原文；缺失参数须生成固定定义，不使用猜测值替代。`);return[p,available[p]];}))};}
  async read(id){if(this.loaded.has(id))return this.loaded.get(id);const d=await this.library.read(id);const result={...d,canonical:!d.imported,version:d.sha256,structured:extractPanels(d.content)};this.loaded.set(id,result);return result;}
  async rules(ids,{includeDependencies=true}={}){const closure=ruleClosure(ids),docs=[];for(const id of includeDependencies?closure:[...new Set(ids)]){if(!this.ruleCache.has(id)){const r=RULES[id],d=this.library.list().find(d=>d.title.includes(r.title)&&d.path.includes('机制设计'));if(!d)throw new Error(`规则资料缺失：${r.title}`);this.ruleCache.set(id,{rule:id,dependencies:r.dependencies,...await this.read(d.id)});}docs.push(this.ruleCache.get(id));}return docs;}
  source(ref){
    // Player-authored or generated definitions are durable database records, not
    // bundled Markdown files. Keep their exact input as provenance while still
    // requiring canonical definitions to cite a loaded formal document.
    if(ref?.kind==='player' || ref?.kind==='generated'){
      if(!ref.quote?.trim())throw new Error('SOURCE_REQUIRED：生成内容需要保留玩家输入或生成依据。');
      return{documentId:ref.documentId||'player-input',path:ref.path||'本轮玩家输入',version:ref.version||'runtime',quote:ref.quote,canonical:false};
    }
    const d=this.loaded.get(ref?.documentId);if(!d||!ref.quote||!d.content.includes(ref.quote))throw new Error('SOURCE_REQUIRED：先读取正式资料，并引用原文中的确切字段。');return{documentId:d.id,path:d.path,version:d.sha256,quote:ref.quote,canonical:!d.imported};
  }
  definition(value){
    const source=this.source(value.source);
    const sourceDoc=this.loaded.get(source.documentId);
    if(value.origin==='canonical'&&!source.canonical)throw new Error('导入内容须先登记为版本化定义，不能冒充随扩展提供的正式资料。');
    const next={...structuredClone(value),source,version:value.version||1};
    if(value.type==='character'){
      if(value.origin==='canonical'&&!/\/(?:1\.参与角色|1\.兵种|2\.精英|3\.boss|4\.国家boss|3\.最终Boss|3\.中立兵种|5\.日常兵种)\//i.test(`/${source.path}`))throw new Error('正式人物必须绑定具体人物／兵种档案，不能把国家总览或关联表中的某个数值当成人物面板。');
      const sourceDoc=this.loaded.get(source.documentId),panels=sourceDoc?extractPanels(sourceDoc.content):{};
      if(Object.keys(panels).length){if(value.fields.forms&&(Object.keys(value.fields.forms).length!==Object.keys(panels).length||Object.entries(panels).some(([key,p])=>!value.fields.forms[key]||Object.entries(p).some(([s,n])=>value.fields.forms[key][s]!==n))))throw new Error('SOURCE_FIELD_MISMATCH：形态面板与原文解析结果不符，请直接采用structured面板。');next.fields.forms=panels;}
      next.fields.eligible=source.canonical&&source.path.includes('1.参与角色/');
      const text=sourceDoc?.content||'';
      if(value.origin==='canonical'){if(/gender\s*:\s*Female/i.test(text))next.fields.gender='female';else if(/性别设定[^\n]*(?:男性|雄性|男性人格)/.test(text))next.fields.gender=/性别设定[^\n]*构造体/.test(text)?'construct':'male';}
      if(source.canonical&&text.includes('world-boss-velsarn')&&text.includes('转形时保留已支付后的实际剩余值')){next.fields.formResourceMode='absolute';next.fields.battlePhases=['world-boss-velsarn-human','world-boss-velsarn-true'];}
    }
    if(value.origin==='canonical'&&sourceDoc){next.fieldSources??={};for(const key of ['age']){if(typeof next.fields?.[key]!=='number'||next.fieldSources[key])continue;const label=key+':',numeric=String(next.fields[key]),line=sourceDoc.content.split(/\r?\n/).find(row=>row.toLowerCase().includes(label.toLowerCase())&&row.includes(numeric));if(line)next.fieldSources[key]=line;}}
    if(value.origin==='canonical'&&next.fieldSources)value.fieldSources=next.fieldSources;
    for(const k of ['wallet','basePrice','currency','priceMultiplier']){if(next.fields)delete next.fields[k];if(next.fieldSources)delete next.fieldSources[k];}
    const visit=(v,path)=>{if(v&&typeof v==='object'){for(const[k,n]of Object.entries(v))visit(n,path?`${path}.${k}`:k);return;}
      if(typeof v!=='number'||path.startsWith('forms.')&&value.type==='character'&&value.origin==='canonical'&&extractPanels(this.loaded.get(source.documentId).content)[path.split('.')[1]])return;
      if(value.origin==='canonical'){const cite=value.fieldSources?.[path],numeric=String(v).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');if(!cite||!sourceDoc?.content.includes(cite)||!new RegExp(`(^|[^0-9])${numeric}([^0-9]|$)`).test(cite.replaceAll('−','-')))throw new Error(`SOURCE_FIELD_MISMATCH：${path} 数值必须有精确原文引文；原文未定时使用generated并说明缺失字段。`);}};
    visit(next.fields,'');return next;
  }
}
export function extractPanels(text){
  const result={};for(const line of text.split('\n')){
    const values=[...line.matchAll(/\[(HP|MP|Atk|Armor|Speed)\s*[:：]\s*(\d+)(?:\/(\d+))?\]/gi)];if(values.length!==5)continue;
    const key=/未变身|日常/.test(line)?'normal':/变身后|变身[：:]/.test(line)?'transformed':null;if(!key)continue;
    const names={hp:'hp',mp:'mp',atk:'attack',armor:'defense',speed:'speed'};result[key]=Object.fromEntries(values.map(m=>[names[m[1].toLowerCase()],Number(m[3]||m[2])]));
  }
  const lines=text.split('\n');for(let i=0;i<lines.length;i++){
    const heads=lines[i].split('|').map(v=>v.trim()).filter(Boolean);
    if(!heads.some(v=>/^HP/.test(v))||!heads.some(v=>v==='攻击')||!heads.some(v=>v==='速度'))continue;
    for(let j=i+2;j<lines.length&&lines[j].trim().startsWith('|');j++){
      const cells=lines[j].split('|').map(v=>v.trim()).filter(Boolean),p={};let id='normal';
      heads.forEach((h,k)=>{const m=cells[k]?.match(/\d+/g);if(h.includes('形态标识'))id=cells[k];const stat=/^HP/.test(h)?'hp':/^MP/.test(h)?'mp':h==='攻击'?'attack':h==='防御'?'defense':h==='速度'?'speed':null;if(stat&&m)p[stat]=Number(m.at(-1));});
      if(Object.keys(p).length===5)result[id]=p;
    }
  }return result;
}
