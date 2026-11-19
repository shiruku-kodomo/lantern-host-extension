import {nativeFixture} from './native-fixture.mjs';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {IDBFactory} from 'fake-indexeddb';
import {LocalStore} from '../src/storage.js';
import {GameDatabase} from '../src/game-db.js';
import {DocumentLibrary} from '../src/documents.js';
import {HostRuntime} from '../src/agents.js';
import {ModelClient} from '../src/provider.js';
import {normalizeSettings} from '../src/core.js';

// Explicit local inputs only. Never write a provider key into a test artifact.
const [settingsFile, label='opening', maxRequests='16'] = process.argv.slice(2);
if(!settingsFile)throw new Error('Pass the local Tavern settings file; credentials remain in memory.');
const raw=JSON.parse(await readFile(settingsFile,'utf8'));
const settings=normalizeSettings(raw.extension_settings?.lantern_host);
const profile=settings.profiles.find(p=>p.id===settings.activeProfileId);
if(!profile)throw new Error('No active host profile.');
const origin=process.env.TAVERN_URL||'http://127.0.0.1:8000';
const csrf=await fetch(`${origin}/csrf-token`), cookies=csrf.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
const {token}=await csrf.json();
const headers=()=>({'Content-Type':'application/json',Cookie:cookies,'X-CSRF-Token':token});
const client=new ModelClient({headers},(url,options)=>fetch(new URL(url,origin),options));
const store=new LocalStore(`opening-test-${Date.now()}`,new IDBFactory()); await store.ready;
const db=new GameDatabase(store);
const resume=process.env.PLAYTHROUGH_RESUME_FILE?JSON.parse(await readFile(process.env.PLAYTHROUGH_RESUME_FILE,'utf8')):null;
const campaign=resume?.branch.campaignId||`qa-${label}-${Date.now()}`;await db.create(campaign,'main');
if(resume){const records=process.env.PLAYTHROUGH_RESTART_STAGE?resume.records.filter(r=>!(r.store==='runs'&&r.value.userId===`stage-${process.env.PLAYTHROUGH_RESTART_STAGE}`)):resume.records;await store.batch([...records,{store:'branches',key:`${campaign}:main`,value:resume.branch}]);}
const library=await new DocumentLibrary(store,new URL('../content/',import.meta.url),async url=>new Response(await readFile(url))).init();
const controller=new AbortController(), timer=setTimeout(()=>controller.abort(new Error('Live opening time budget reached')),240000);
let requests=0,lastTrace=0; const started=Date.now();
const model={turn:async(...args)=>{if(++requests>Number(maxRequests))throw new Error('Live opening request budget reached');console.log(`MODEL ${requests} +${Math.round((Date.now()-started)/1000)}s`);return client.turn(...args);},chat:(...args)=>client.chat(...args)};
const fixture=await nativeFixture(store,db,campaign);const runtime=new HostRuntime({store,db,model,library,projection:fixture.projection});runtime.chatKey=fixture.bridge.key();
const input=['请你以第一人称视角，扮演"月晓菲"','保证月晓菲的性格特征(傲慢、狡诈、伪善）','确保40%内容为内心独白，50%为对话内容，肢体描写尽量角色的肢体动作是什么，尤其是腿部。角色语言优雅，冷静','输出内容确保口语化','','大白天，你在和user即将扮演的身份交流着，进行闲聊','根据月晓菲的背景故事 和她对于剿灭邪恶的决心 输出开场白','并决定user即将扮演的人物，以及他的身份、如何和月晓菲认识、并之后准备一起行动','','随后，引导月晓菲该做任务了，于是月晓菲开始查阅情报并随机抽出三个任务，让user参与一起思考','','详细描写上述过程','现在时间：2020年5月16日'].join('\n');
let run,error;
try{run=await runtime.execute({campaignId:campaign,branchId:'main',user:{id:'opening',content:input},profile,settings,messages:[],signal:controller.signal,onUpdate:r=>{run=r;for(const t of r.trace.slice(lastTrace))if(t.kind==='tool'&&t.status!=='running')console.log(`TOOL ${t.agent} ${t.tool} ${t.status}${t.error?' '+t.error:''}`);lastTrace=r.trace.length;}});}catch(e){error=e.message;}finally{clearTimeout(timer);}
const playthrough=resume?.completed||[];
await mkdir(new URL('../test-results/',import.meta.url),{recursive:true});
if(!error&&process.env.PLAYTHROUGH==='1'){
  const steps=[
    ['accept',w=>`我选择接取第一个任务「${w.quests[w.questBoard.questIds[0]].name}」。我和月晓菲一起参加，由月晓菲带队。只登记接取，不替我自动执行任务。`],
    ['investigate',w=>`开始执行当前任务：在月晓菲目前所在地点，先与可以合理接触的工作人员交谈，核实本任务涉及的时间和公开线索。只推进这一项调查行动，需要判定就实际判定；所得情报登记到各自知情范围，不提前完成整个任务。`],
    ['event',w=>'现在请为这一轮实际抽取一次突发事件，按真实骰子确定事件类别并登记本轮结果；如出现新的选择，停下来让我选择，不直接替我处理。'],
    ['battle',w=>'测试遭遇：一名中国内廷缉事府的缉事巡役在当前地点现身并发动攻击。月晓菲立即变身，玩家退到安全处不参战。请用原文面板与真实战斗工具结算这一个五次交锋块，登记结果和必要后果；到下一选择停下。不要直接跑整场战斗或整个任务。'],
  ];
  const history=[{role:'user',content:input},{role:'assistant',content:run.output||''}];
  for(const done of playthrough)history.push({role:'user',content:done.input},{role:'assistant',content:done.output||''});
  for(const [name,build]of steps){
    if(playthrough.some(done=>done.name===name&&!done.error))continue;
    const before=(await db.get(campaign,'main')).world,content=build(before),requestStart=requests,at=Date.now();
    const stageTimer=setTimeout(()=>controller.abort(new Error(`Stage ${name} time budget reached`)),240000);lastTrace=0;let current,stageError;
    const stageOptions={campaignId:campaign,branchId:'main',user:{id:`stage-${name}`,content},profile,settings,messages:history.slice(-6),signal:controller.signal,onUpdate:r=>{current=r;for(const t of r.trace.slice(lastTrace))if(t.kind==='tool'&&t.status!=='running')console.log(`TOOL ${name} ${t.agent} ${t.tool}${t.parameters?.type?' '+t.parameters.type:''} ${t.status}${t.error?' '+t.error:''}`);lastTrace=r.trace.length;}};
    try{current=await runtime.execute(stageOptions);}catch(e){stageError=e.message;}finally{clearTimeout(stageTimer);}
    const after=(await db.get(campaign,'main')).world,rollCount=(await store.list('rolls')).length;
    if(!stageError){await runtime.execute(stageOptions);if((await store.list('rolls')).length!==rollCount)stageError='Replay added new dice';}
    const record={name,input:content,status:current?.status,error:stageError,requests:requests-requestStart,elapsedMs:Date.now()-at,beforeRevision:before.revision,afterRevision:after.revision,rollCount,world:after,trace:current?.trace,output:current?.output};playthrough.push(record);
    const records=[];
    for(const name of ['rolls','events','plans','runs','turns'])for(const value of await store.list(name,`${campaign}:main:`))records.push({store:name,key:`qa-opening:main:${value.id}`,value});
    for(const turn of await store.list('turns',`${campaign}:main:`)){const value=await store.read('snapshots',`qa-opening:main:${turn.userId}`);if(value)records.push({store:'snapshots',key:`qa-opening:main:${turn.userId}`,value});}
    await writeFile(new URL('../test-results/playthrough-checkpoint.json',import.meta.url),JSON.stringify({branch:await db.get(campaign,'main'),records,completed:playthrough.filter(x=>!x.error)},null,2).replaceAll(profile.apiKey||'__NO_KEY__','[REDACTED]'));
    const safe=JSON.stringify(record,null,2).replaceAll(profile.apiKey||'__NO_KEY__','[REDACTED]');await writeFile(new URL(`../test-results/play-${name}.json`,import.meta.url),safe);
    console.log(JSON.stringify({stage:name,status:record.status,error:stageError,requests:record.requests,elapsedMs:record.elapsedMs,beforeRevision:before.revision,afterRevision:after.revision,rollCount}));
    if(stageError){error=stageError;break;}
    history.push({role:'user',content},{role:'assistant',content:current.output||''});
  }
}
const world=(await db.get(campaign,'main')).world;
const report={label,model:profile.model,requests,elapsedMs:Date.now()-started,status:run?.status,error,playthrough,entityCount:Object.keys(world.entities).length,entities:Object.values(world.entities).map(e=>({id:e.id,name:e.name,kind:e.kind,forms:e.forms,affection:e.affection,personality:e.personality})),questCount:Object.keys(world.quests).length,knowledgeCount:Object.keys(world.knowledge).length,rollCount:(await store.list('rolls')).length,trace:run?.trace,output:run?.output};
const safe=JSON.stringify(report,null,2).replaceAll(profile.apiKey||'__NO_KEY__','[REDACTED]');
await mkdir(new URL('../test-results/',import.meta.url),{recursive:true});
await writeFile(new URL(`../test-results/${label}.json`,import.meta.url),safe);
console.log(JSON.stringify({label,requests,elapsedMs:report.elapsedMs,status:report.status,error,entities:report.entities.map(e=>({name:e.name,kind:e.kind})),quests:report.questCount,knowledge:report.knowledgeCount}));
if(error)process.exitCode=1;
