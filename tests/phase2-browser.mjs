import {serveSource} from './serve-source.mjs';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
if(!process.env.TAVERN_URL)throw new Error('Use an isolated QA Tavern.');
const catalog=JSON.parse(await readFile(new URL('../content/catalog.json',import.meta.url)));
const characterDoc=catalog.entries.find(d=>d.path.endsWith('柠彩莲/柠彩莲.md'));
const source=JSON.parse(await readFile(new URL(`../content/${characterDoc.part}`,import.meta.url)))[characterDoc.id];
const quote=source.split('\n').slice(0,13).join('\n');
const requests=[],results=[];let fixtureMode='workflow';
const tool=(name,args)=>({id:`call-${crypto.randomUUID()}`,type:'function',function:{name,arguments:JSON.stringify(args)}});
const server=createServer(async(req,res)=>{
  if(req.url.endsWith('/models')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'gpt-6.1-sol'}]}));return;}
  let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);requests.push(body);
  const tools=body.tools||[],messages=body.messages,system=messages[0].content,done=messages.filter(m=>m.role==='tool').map(m=>{try{return JSON.parse(m.content);}catch{return{};}});
  let calls=[],content='';
  if(fixtureMode==='discussion')content='设置讨论，不改变正式数值。';
  else if(tools.some(t=>t.function.name==='propose_plan')){
    if(!done.length)calls=[tool('propose_plan',{goal:'按正式资料建立柠彩莲并登记姓名情报',steps:[{id:'create',agent:'analysis',task:'读取正式角色并自动建档',dependencies:[],tools:['read_content','mechanism']},{id:'know',agent:'intelligence',task:'登记已知姓名',dependencies:['create'],tools:['mechanism']} ]})];else content='计划已列好，点击执行后建档。';
  }else if(system.startsWith('你是主持')){
    if(!done.some(v=>v.agent==='analysis'))calls=[tool('delegate',{role:'analysis',task:'按柠彩莲正式资料自动建立本局角色'} )];
    else if(!done.some(v=>v.agent==='intelligence'))calls=[tool('delegate',{role:'intelligence',task:'登记角色实际知道自己的姓名，来源为自我身份认知'})];
    else content='## 本轮结果\n\n已按正式面板建立柠彩莲，记录其已知身份。\n\n等待玩家选择下一行动。';
  }else if(system.startsWith('你是分析Agent')){
    if(!done.length)calls=[tool('read_state',{})];else content='复用扩展已经登记的正式角色，不再重复建档。';
  }else if(system.startsWith('你是情报Agent')){
    if(!done.length)calls=[tool('mechanism',{id:'known-name',type:'knowledge.record',args:{id:'known-cailian-name',subjectId:`canonical:${characterDoc.entityId}`,subjectLabel:'柠彩莲',field:'姓名',value:'柠彩莲',knowers:[`canonical:${characterDoc.entityId}`],status:'verified',source:'人物自身身份认知'}})];else content='已登记角色自身知情。';
  }else content='摘要：保留事实和停点。';
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[{delta:{content,...(calls.length?{tool_calls:calls.map((c,index)=>({...c,index}))}:{})},finish_reason:calls.length?'tool_calls':'stop'}],usage:{prompt_tokens:120,completion_tokens:30}})}\n\ndata: [DONE]\n\n`);
});server.listen(0,'127.0.0.1');await once(server,'listening');
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH,headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
const host=page.locator('#lantern-host-root');let avatar,settings;
const app=fn=>page.evaluate(fn);
async function check(name,fn){await fn();results.push({name,pass:true});console.log('PASS',name);}
async function state(){return app(async()=>{const a=await(await import('/scripts/extensions/third-party/lantern-host-extension/index.js')).enable(),b=a.sessions.current(a.key).binding;return{binding:b,branch:await a.sessions.db.get(b.campaignId,b.branchId),rolls:await a.storage.list('rolls',`${b.campaignId}:${b.branchId}:`),runs:await a.storage.list('runs',`${b.campaignId}:${b.branchId}:`),error:a.error,saveError:a.saveError};});}
async function settled(){await page.waitForFunction(()=>!LanternHost.getStatus().busy);await page.waitForTimeout(600);}
try{
  await serveSource(page);await page.route('**/api/worldinfo/list',route=>route.fulfill({status:404,body:'older Tavern has no list endpoint'}));await page.goto(process.env.TAVERN_URL,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>!!window.LanternHost);
  const welcome=page.locator('dialog[open]').filter({has:page.locator('[data-i18n="Welcome to SillyTavern!"]')});if(await welcome.count())await welcome.locator('.popup-button-ok').click();
  settings=await app(()=>structuredClone(SillyTavern.getContext().extensionSettings.lantern_host));
  avatar=await app(async()=>{const c=SillyTavern.getContext(),r=await fetch('/api/characters/create',{method:'POST',headers:c.getRequestHeaders(),body:JSON.stringify({ch_name:`Lantern-Phase2-${Date.now()}`,description:'QA',first_mes:'QA'})});const avatar=await r.text();await c.getCharacters();await c.selectCharacterById(c.characters.findIndex(x=>x.avatar===avatar));return avatar;});await page.waitForTimeout(700);
  await page.evaluate(async endpoint=>{const a=await(await import('/scripts/extensions/third-party/lantern-host-extension/index.js')).enable();a.settings={...a.settings,activeProfileId:'qa',profiles:[{id:'qa',name:'QA',protocol:'openai',baseUrl:endpoint,apiKey:'fixture-only',model:'gpt-6.1-sol',maxTokens:4096}],systemPrompt:'依原策划使用真实工具',autoCompact:true};await a.bridge.saveSettings(a.settings);a.session.mode='plan';a.open();},`http://127.0.0.1:${server.address().port}/v1`);
  const firstChat=await app(()=>SillyTavern.getContext().chatId);
  await check('plan card is real and confirmation leaves DB unchanged',async()=>{
    await host.locator('#lh-input').fill('我选择柠彩莲开局，请按正式资料建档并记录她知道自己的名字');await host.locator('.lh-composer button[type=submit]').click();await settled();
    await host.locator('[data-action=plan-execute]').waitFor();const s=await state();assert.equal(s.branch.world.revision,0);assert.equal(s.rolls.length,0);assert.equal(s.branch.session.messages.length,2);
  });
  await check('confirmed host delegates real analysis and intelligence tools, commits and archives',async()=>{
    await host.locator('[data-action=plan-execute]').click();await settled();const s=await state();assert.equal(Object.values(s.branch.world.entities).find(e=>e.name==='柠彩莲').forms.normal.hp,100,JSON.stringify(s));assert.equal(Object.values(s.branch.world.entities).find(e=>e.name==='柠彩莲').forms.transformed.attack,180);assert.equal(s.rolls.length,1);assert.equal(s.branch.world.revision,1);assert.equal(s.branch.session.messages.at(-1).commit.reused,false);assert.ok(s.branch.world.knowledge['known-cailian-name']);assert.equal(s.saveError,'');
    assert.ok(await host.locator('.lh-timeline').count());const tools=host.locator('.lh-tool-group').last();if(!await tools.evaluate(n=>n.open))await tools.locator(':scope > summary').click();await page.screenshot({path:new URL('../test-results/phase2-desktop.png',import.meta.url).pathname.replace(/^\/(.:)/,'$1')});
    await host.locator('[data-action=archives]').click();assert.ok((await host.locator('.lh-modal textarea').inputValue()).includes('我选择柠彩莲开局'));await host.locator('[data-action=preview-close]').click();
  });
  let book;
  await check('native worldbook file and actual Tavern scan contain blue System @D 9999 known facts',async()=>{
    const scan=await app(async()=>{const c=SillyTavern.getContext(),name=c.chatMetadata.world_info,data=await(await fetch('/api/worldinfo/get',{method:'POST',headers:c.getRequestHeaders(),body:JSON.stringify({name})})).json(),mod=await import('/scripts/world-info.js');return{name,data,prompt:await mod.getWorldInfoPrompt(['QA current chat'],475000,true)};});book=scan.name;
    const entry=Object.values(scan.data.entries).find(e=>e.extensions?.lanternHost);assert.ok(entry,JSON.stringify(scan));assert.equal(entry.constant,true);assert.equal(entry.role,0);assert.equal(entry.position,4);assert.equal(entry.depth,9999);assert.ok(JSON.stringify(scan.prompt.worldInfoDepth).includes('柠彩莲'));assert.equal(scan.prompt.worldInfoDepth[0].depth,9999);
  });
  await check('handoff includes exact player source and only fills native composer',async()=>{
    await host.locator('[data-action=preview]').last().click();assert.ok((await host.locator('#lh-handoff').inputValue()).includes('我选择柠彩莲开局，请按正式资料建档并记录她知道自己的名字'));await host.locator('[data-action=handoff][data-mode=replace]').click();await host.locator('.lh-backdrop').waitFor({state:'hidden'});assert.ok((await page.locator('#send_textarea').inputValue()).includes('【玩家本轮原话】'));assert.equal(await app(()=>SillyTavern.getContext().chat.filter(m=>m.is_user).length),0);await app(()=>LanternHost.open());
  });
  await check('retry reuses settlement; new chat has initial worldbook and old chat restores projection',async()=>{
    const old=await state();await host.locator('[data-action=retry]').last().click();await settled();const retried=await state();assert.equal(retried.branch.world.revision,1);assert.equal(retried.rolls.length,old.rolls.length);
    await app(async()=>SillyTavern.getContext().openCharacterChat(`Lantern-phase2-new-${Date.now()}`));await page.waitForTimeout(700);const fresh=await state();assert.notEqual(fresh.binding.campaignId,old.binding.campaignId);assert.equal(Object.keys(fresh.branch.world.entities).length,0);assert.equal(await app(()=>SillyTavern.getContext().chatMetadata.world_info||null),null);
    await page.evaluate(async chat=>SillyTavern.getContext().openCharacterChat(chat),firstChat);await page.waitForTimeout(700);assert.equal((await state()).binding.campaignId,old.binding.campaignId);assert.equal(await app(()=>SillyTavern.getContext().chatMetadata.world_info),book);
  });
  await check('native backup is verified, chat metadata stays small, and missing worldbook regenerates',async()=>{
    const s=await state();assert.equal(s.binding.backup.sha256.length,64);assert.ok(JSON.stringify(s.binding).length<2000);
    await page.evaluate(async name=>{const c=SillyTavern.getContext();await fetch('/api/worldinfo/delete',{method:'POST',headers:c.getRequestHeaders(),body:JSON.stringify({name})});const a=await(await import('/scripts/extensions/third-party/lantern-host-extension/index.js')).enable(),b=a.sessions.current(a.key).binding;await a.projection.sync(b.campaignId,b.branchId,a.key);},book);
    const s2=await state();assert.equal(s2.branch.worldbook.name,book);
  });
  await check('mobile uses same runtime, plan UI and always visible restored launcher',async()=>{
    await page.setViewportSize({width:390,height:440});const box=await host.locator('.lh-panel').boundingBox();assert.ok(box.y>=-1&&box.y+box.height<=441);await host.locator('[data-window=close]').click();await host.locator('.lh-launcher').waitFor();await host.locator('.lh-launcher').click();await page.waitForTimeout(250);assert.ok(await host.locator('.lh-message').count());await page.screenshot({path:new URL('../test-results/phase2-mobile.png',import.meta.url).pathname.replace(/^\/(.:)/,'$1')});
  });
  await check('native worldbook outage leaves retry queue and still fills edited handoff with current facts',async()=>{
    fixtureMode='discussion';
    await app(async()=>{const a=await(await import('/scripts/extensions/third-party/lantern-host-extension/index.js')).enable(),b=a.sessions.current(a.key).binding,branch=await a.sessions.db.get(b.campaignId,b.branchId),w=structuredClone(branch.world),id=Object.values(w.entities).find(e=>e.name==='柠彩莲').id;a.session.mode='chat';a.render();w.knowledge['qa-outage']={id:'qa-outage',subjectId:id,field:'新观察',value:'QA outage fresh fact',knowers:[id],source:'QA witnessed',status:'observation',active:true,at:w.time};await a.sessions.db.commit(b.campaignId,b.branchId,{id:'qa-outage',baseRevision:w.revision,world:w,operations:[],source:{qa:true}});});
    await page.route('**/api/worldinfo/edit',route=>route.fulfill({status:404,body:'QA unavailable'}));
    await host.locator('#lh-input').fill('确认刚刚记录的新观察');await host.locator('.lh-composer button[type=submit]').click();await settled();const before=await state();assert.ok(before.branch.session.messages.at(-1).worldbookError);
    await host.locator('[data-action=preview]').last().click();await host.locator('#lh-handoff').fill('QA edited original handoff');await host.locator('[data-action=handoff][data-mode=append]').click();await host.locator('.lh-modal').waitFor({state:'hidden'});
    const input=await page.locator('#send_textarea').inputValue();assert.ok(input.includes('QA edited original handoff'));assert.ok(input.includes('QA outage fresh fact'));
    await page.unroute('**/api/worldinfo/edit');await app(async()=>{const a=await(await import('/scripts/extensions/third-party/lantern-host-extension/index.js')).enable();a.open();await a.action('retry-save',{});});
    const after=await state();assert.equal(after.branch.world.revision,before.branch.world.revision);assert.equal(after.rolls.length,before.rolls.length);assert.equal(after.branch.worldbook.revision,after.branch.world.revision);
  });
  await check('progress is compact, preserves expanded details and scroll across incremental updates and rerenders',async()=>{
    await page.setViewportSize({width:1200,height:900});
    await app(async()=>{
      const a=await(await import('/scripts/extensions/third-party/lantern-host-extension/index.js')).enable(),{appendMessage}=await import('/scripts/extensions/third-party/lantern-host-extension/src/conversation.js');
      const trace=[{id:'ui-note',kind:'agent',agent:'analysis',task:'读取正式资料并核对数值',status:'running'}];
      for(let i=0;i<35;i++){trace.push({id:`ui-${i}-start`,stepId:`read-${i}`,kind:'tool',agent:'analysis',tool:'read_content',parameters:{id:`doc-${i}`},status:'running'});trace.push({id:`ui-${i}-end`,stepId:`read-${i}`,kind:'tool',agent:'analysis',tool:'read_content',parameters:{id:`doc-${i}`},result:{path:`资料/正式资料${i}.md`,content:'RAW_ONLY_LONG_CONTENT '.repeat(300)},status:'complete'});}
      const m=appendMessage(a.session,{id:'ui-progress-check',role:'assistant',content:'',status:'running',trace});a.render();
    });
    const row=host.locator('[data-message-id=ui-progress-check]'),group=row.locator('.lh-tool-group');
    assert.equal(await row.locator('.lh-tool-step').count(),35);assert.equal(await row.locator('.lh-operation-json:visible').count(),0);
    const step=row.locator('.lh-tool-step').first();assert.equal(await row.locator('.lh-tool-step details, pre').count(),0);assert.equal((await row.innerText()).includes('RAW_ONLY_LONG_CONTENT'),false);
    await page.evaluate(()=>{window.__lhProgressElement=document.querySelector('[data-message-id=ui-progress-check] .lh-tool-step');document.querySelector('.lh-messages').scrollTop=120;});
    const top=await host.locator('.lh-messages').evaluate(n=>n.scrollTop);
    await app(async()=>{const a=await(await import('/scripts/extensions/third-party/lantern-host-extension/index.js')).enable(),m=a.session.messages.find(m=>m.id==='ui-progress-check');m.trace.push({id:'new-start',stepId:'new',kind:'tool',agent:'analysis',tool:'read_fields',parameters:{id:'next'},status:'running'});a.renderRun(document.querySelector('[data-message-id=ui-progress-check]'),m);});
    assert.equal(await step.evaluate(n=>n===window.__lhProgressElement),true);assert.equal(await group.evaluate(n=>n.open),true);assert.ok(Math.abs((await host.locator('.lh-messages').evaluate(n=>n.scrollTop))-top)<2);
    await group.locator(':scope > summary').click();assert.equal(await group.evaluate(n=>n.open),false);
    await app(async()=>{const a=await(await import('/scripts/extensions/third-party/lantern-host-extension/index.js')).enable(),m=a.session.messages.find(m=>m.id==='ui-progress-check');m.trace.push({id:'new-end',stepId:'new',kind:'tool',agent:'analysis',tool:'read_fields',parameters:{id:'next'},result:{fields:{hp:{value:100}}},status:'complete'});a.renderRun(document.querySelector('[data-message-id=ui-progress-check]'),m);});
    assert.equal(await group.evaluate(n=>n.open),false);await group.locator(':scope > summary').click();await app(async()=>{const a=await(await import('/scripts/extensions/third-party/lantern-host-extension/index.js')).enable();a.render();});assert.equal(await row.locator('.lh-tool-group').evaluate(n=>n.open),true);assert.equal(await row.locator('.lh-tool-step details, pre').count(),0);
    await page.screenshot({path:new URL('../test-results/activity-desktop.png',import.meta.url).pathname.replace(/^\/(.:)/,'$1')});
    await page.setViewportSize({width:390,height:600});await page.screenshot({path:new URL('../test-results/activity-mobile.png',import.meta.url).pathname.replace(/^\/(.:)/,'$1')});
    await app(async()=>{const a=await(await import('/scripts/extensions/third-party/lantern-host-extension/index.js')).enable();a.session.conversation.nodes=a.session.conversation.nodes.filter(m=>m.id!=='ui-progress-check');const{hydrateConversation}=await import('/scripts/extensions/third-party/lantern-host-extension/src/conversation.js');hydrateConversation(a.session);a.render();});
  });
}catch(error){results.push({name:'phase2 failure',pass:false,error:error.message});console.error(error);console.error(JSON.stringify((await state().catch(()=>null))?.runs?.flatMap(r=>r.trace.filter(t=>t.status==='failed').map(t=>({tool:t.tool,error:t.error})))));process.exitCode=1;}
finally{
  if(settings)await page.evaluate(async saved=>{const a=await(await import('/scripts/extensions/third-party/lantern-host-extension/index.js')).enable();await a.bridge.saveSettings(saved);},settings).catch(()=>{});
  await writeFile(new URL('../test-results/phase2-results.json',import.meta.url),JSON.stringify({at:new Date().toISOString(),results,requests:requests.length,physicalDevice:false},null,2));await browser.close();server.closeAllConnections();server.close();
}
