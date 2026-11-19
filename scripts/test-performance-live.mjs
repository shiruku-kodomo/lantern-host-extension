import {readFile,writeFile} from 'node:fs/promises';
import {IDBFactory} from 'fake-indexeddb';
import {LocalStore} from '../src/storage.js';
import {GameDatabase} from '../src/game-db.js';
import {ContentRegistry} from '../src/rules.js';
import {MechanismEngine} from '../src/mechanisms.js';
import {DocumentLibrary} from '../src/documents.js';
import {HostRuntime} from '../src/agents.js';
import {ModelClient} from '../src/provider.js';
import {normalizeSettings} from '../src/core.js';
import {nativeFixture} from './native-fixture.mjs';
const settings=normalizeSettings(JSON.parse(await readFile(process.argv[2],'utf8')).extension_settings.lantern_host),profile=settings.profiles.find(p=>p.id===settings.activeProfileId);
if(!profile)throw Error('Active host profile missing');
const origin='http://127.0.0.1:8000',response=await fetch(origin+'/csrf-token'),cookies=response.headers.getSetCookie().map(c=>c.split(';')[0]).join('; '),{token}=await response.json(),headers=()=>({'Content-Type':'application/json',Cookie:cookies,'X-CSRF-Token':token});
const client=new ModelClient({headers},(url,options)=>fetch(new URL(url,origin),options)),results=[];
const cases=[...Array.from({length:3},(_,i)=>({name:`ordinary-${i+1}`,hero:'月晓菲',enemy:'缉事巡役',ordinary:true})),...Array.from({length:3},(_,i)=>({name:`battle-${i+1}`,hero:'月晓菲',enemy:'缉事巡役'})),{name:'initial-cailian-boss',hero:'柠彩莲',enemy:'万藏之王·维尔萨恩'},{name:'initial-cailian-20',hero:'柠彩莲',enemy:'缉事巡役',count:20}];
async function scenario(spec){
 const campaign=`performance-${spec.name}-${Date.now()}`,store=new LocalStore(campaign,new IDBFactory()),db=new GameDatabase(store);let branch=await db.create(campaign,'main');
 const library=await new DocumentLibrary(store,new URL('../content/',import.meta.url),async url=>new Response(await readFile(url))).init(),registry=new ContentRegistry(library),engine=new MechanismEngine({db,campaignId:campaign,branchId:'main',registry,runId:'setup'});
 let world=branch.world,opCount=0;const apply=async(type,args)=>{world=(await engine.execute(world,{id:`setup-${++opCount}`,type,args})).world;};
 async function define(name,id){const doc=library.list().find(d=>d.path.endsWith('/'+name+'.md'));if(!doc)throw Error('Missing canonical '+name);const data=await registry.read(doc.id);await apply('definition.create',{id,name,type:'character',origin:'canonical',source:{documentId:doc.id,quote:data.content},fields:{personality:data.content.match(/^personality:\s*(.*)/m)?.[1]||'按正式人物设定行动'}});}
 await define(spec.hero,'hero-definition');await define(spec.enemy,'enemy-definition');await apply('entity.create',{id:'hero',definitionId:'hero-definition',opening:true,location:'当前场景'});
 for(let i=1;i<=(spec.count||1);i++)await apply('entity.create',{id:`enemy-${i}`,definitionId:'enemy-definition',kind:spec.name.includes('boss')?'world-boss':'troop',historical:true,location:'当前场景'});
 if(spec.ordinary)await apply('quest.create',{id:'prepared-quest',name:'核实街头求助',goal:'核实求助情况',completion:'确认当事人与证据',failure:'求助者离开',location:'当前场景',level:1,hiddenFailure:'证人已离开原处'});
 await db.commit(campaign,'main',{id:'setup',baseRevision:0,world,operations:[],source:{fixture:true}});
 const fixture=await nativeFixture(store,db,campaign);let requests=0,current;const model={turn:(...args)=>{console.log('REQUEST '+spec.name+' '+(requests+1));if(++requests>8)throw Error('QA request budget exceeded');return client.turn(...args);},chat:(...args)=>client.chat(...args)};
 const runtime=new HostRuntime({store,db,model,library,projection:fixture.projection});runtime.chatKey=fixture.bridge.key();
 const input=spec.ordinary?`我和${spec.hero}接取已登记的任务“核实街头求助”，由${spec.hero}带队。只登记接取，不自动调查或触发事件。`:`${spec.hero}遭遇当前场景中的${spec.count||1}名${spec.enemy}攻击。她立即变身，以普通攻击和防守迎战，不使用尚未定义的技能。按正式面板和真实骰子执行这段连续战斗，记录战果及必要后果，到重大新选择处停下。只给简短主持结果，正文交给酒馆。`;
 const signal=AbortSignal.timeout(180000),started=Date.now(),beforeRolls=(await store.list('rolls')).length;let error;
 const options={campaignId:campaign,branchId:'main',user:{id:'turn',content:input},profile,settings,messages:[],signal,onUpdate:r=>{current=r;}};
 try{current=await runtime.execute(options);const dice=(await store.list('rolls')).length;await runtime.execute(options);if((await store.list('rolls')).length!==dice)throw Error('Replay rerolled');}catch(e){error=e.message;}
 const after=await db.get(campaign,'main');if(!error&&spec.ordinary&&after.world.quests['prepared-quest'].status!=='active')error='Quest was not accepted';if(!error&&!spec.ordinary&&!Object.values(after.world.battles).some(b=>b.rounds.length===5))error='No complete real combat block';const record={name:spec.name,model:profile.model,requests,elapsedMs:Date.now()-started,error,status:current?.status,worldbookError:current?.worldbookError,worldbook:after.worldbook,rolls:(await store.list('rolls')).length-beforeRolls,battles:after.world.battles,hero:after.world.entities.hero,output:current?.output,trace:current?.trace};
 results.push(record);await writeFile(new URL('../test-results/'+(process.env.OUTPUT_LABEL||'performance-v036')+'.json',import.meta.url),JSON.stringify(results,null,2).replaceAll(profile.apiKey||'__EMPTY__','[REDACTED]'));console.log(JSON.stringify({name:spec.name,requests,elapsedMs:record.elapsedMs,error,status:record.status,rolls:record.rolls,worldbookError:record.worldbookError}));
}
// Each case uses a separate game, real backend files and independent real dice.
for(const spec of cases){if(process.env.CASE_FILTER&&!spec.name.match(new RegExp(process.env.CASE_FILTER)))continue;console.log('CASE '+spec.name);await scenario(spec);}
for(const type of ['ordinary','battle']){const values=results.filter(r=>r.name.startsWith(type+'-')).map(r=>r.elapsedMs).sort((a,b)=>a-b);console.log(JSON.stringify({type,medianMs:values[1],maximumMs:values.at(-1)}));}
if(results.some(r=>r.error||r.worldbookError))process.exitCode=1;
