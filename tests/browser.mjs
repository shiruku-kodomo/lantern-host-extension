import {serveSource} from './serve-source.mjs';
// Integration test against a real, running local SillyTavern. No paid provider is used.
// PLAYWRIGHT_MODULE points to an installed Playwright ESM entry when not in node_modules.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
if (!process.env.TAVERN_URL) throw new Error('Set TAVERN_URL to an isolated QA SillyTavern instance before running integration tests.');
const results = [], requests = [], root = new URL('../test-results/', import.meta.url);
await mkdir(root, { recursive: true });
let mode = 'normal',heldFinish;
const upstream = createServer(async (req, res) => {
  if (req.url.endsWith('/models')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'local-qa-model' }, { id: 'manual-qa-model' }] })); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || '{}'); requests.push(body);
  if (mode === 'error') { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"QA temporary unavailable"}}'); return; }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  if(body.tools?.some(t=>t.function.name==='propose_plan')&&!body.messages?.some(m=>m.role==='tool'&&m.content.includes('等待玩家点击执行'))){
    const plan={goal:'验收计划',steps:[{id:'step-1',agent:'analysis',task:'读取本局资料',dependencies:[],tools:['read_state']}]};
    res.end(`data: ${JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'qa-plan',type:'function',function:{name:'propose_plan',arguments:JSON.stringify(plan)}}]},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`);return;
  }
  const reply = ['主持回复：已读取本轮讨论。', '', '## 本轮结果', '', '**重点**与引用：', '', '> 保留原始记录。', '', '| 项目 | 数值 |', '| --- | --- |', '| 示例 | 17 |', '', '```js', 'const result = 17;', '```', '', '<script>window.__lhUnsafe = true</script>'].join('\n');
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply }, index: 0 }] })}\n\n`);
  const finish=()=>{res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] })}\n\ndata: [DONE]\n\n`);res.end();};
  let timer;if(mode==='keepalive')heldFinish=finish;else timer=setTimeout(finish,mode==='slow'?15000:150);
  res.on('close', () => clearTimeout(timer));
});
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
const endpoint = `http://127.0.0.1:${upstream.address().port}/v1`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = []; page.on('pageerror', error => errors.push(error.message));
page.on('dialog', dialog => dialog.accept());
const host = page.locator('#lantern-host-root');
let avatar, backup;
async function check(name, fn) { await fn(); results.push({ name, pass: true }); console.log(`PASS ${name}`); }
async function ready() {
  await page.waitForFunction(() => !!window.LanternHost && document.querySelector('#send_textarea'));
  await page.waitForTimeout(700);
  const welcome = page.locator('dialog[open]').filter({ has: page.locator('[data-i18n="Welcome to SillyTavern!"]') });
  if (await welcome.count()) await welcome.locator('.popup-button-ok').click();
}
async function open() { await page.evaluate(() => window.LanternHost.open()); await page.waitForTimeout(250); }
async function settled() { await page.waitForFunction(() => !window.LanternHost.getStatus().busy); await page.waitForTimeout(800); }
async function screenshot(name) { await page.waitForTimeout(300); await page.screenshot({ path: fileURLToPath(new URL(name, root)) }); }
try {
  await serveSource(page);await page.goto(process.env.TAVERN_URL || 'http://127.0.0.1:8000/', { waitUntil: 'domcontentloaded' }); await ready();
  backup = await page.evaluate(async () => {
    const ctx = SillyTavern.getContext();
    const data = await (await fetch('/api/settings/get', { method: 'POST', headers: ctx.getRequestHeaders(), body: '{}' })).json();
    const saved = JSON.parse(data.settings);
    return { namespace: saved.extension_settings?.lantern_host, active_character: saved.active_character, active_group: saved.active_group };
  });
  avatar = await page.evaluate(async name => {
    const ctx = SillyTavern.getContext();
    const response = await fetch('/api/characters/create', { method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify({ ch_name: name, name, description: 'QA character description', personality: 'QA careful', scenario: 'QA isolated test', first_mes: 'QA opening', creator: 'Lantern extension automated validation', tags: [] }) });
    if (!response.ok) throw new Error(`create character: ${response.status}`);
    const avatar = await response.text(); await ctx.getCharacters();
    await SillyTavern.getContext().selectCharacterById(SillyTavern.getContext().characters.findIndex(c => c.avatar === avatar));
    return avatar;
  }, `Lantern-QA-${Date.now()}`);
  await page.waitForFunction(() => LanternHost.getStatus().chatBound); await page.waitForTimeout(900); await open();

  await check('standard extension entry and duplicate-safe lifecycle', async () => {
    assert.equal(await host.count(), 1);
    assert.equal(await page.locator('.lantern-host-settings-entry').count(), 1);
    assert.equal(await page.locator('#extensionsMenu').getByText('灯火之外 · 主持', { exact: true }).count(), 1);
  });
  await check('independent profile discovers models and persists explicitly', async () => {
    await host.locator('.lh-nav [data-tab=settings]').click();
    await host.locator('[data-profile=name]').fill('本地验收连接');
    await host.locator('[data-profile=baseUrl]').fill(endpoint);
    await host.locator('[data-profile=apiKey]').fill('test-only-not-a-secret');
    await host.locator('[data-action=models]').click();
    await host.locator('.lh-feedback').filter({ hasText: '找到 2 个模型' }).waitFor();
    assert.equal(await host.locator('#lh-models option').count(), 2);
    await host.locator('[data-profile=model]').fill('local-qa-model');
    await host.locator('[data-action=profile-save]').click();
    await host.locator('.lh-feedback').filter({ hasText: '已保存' }).waitFor();
    await host.locator('#lh-prompt').fill('QA editable host prompt');
    await host.locator('[data-action=prompt-save]').click();
    await host.locator('.lh-feedback').filter({ hasText: '已保存' }).waitFor();
  });
  await check('selected swipe and character data enter actual HTTP model request', async () => {
    await page.evaluate(async () => {
      const ctx = SillyTavern.getContext();
      ctx.chat.push({ is_user: false, name: 'QA', mes: 'old swipe', swipes: ['old swipe', 'selected-qa-swipe'], swipe_id: 1, send_date: new Date().toISOString() }); await ctx.saveChat();
    });
    await host.locator('[data-tab=chat]').click();
    await host.locator('#lh-input').fill('验收：这是独立主持对话。'); await host.locator('.lh-composer').getByRole('button', { name: '发送', exact: true }).click();
    await host.locator('.lh-assistant .lh-message-text').filter({ hasText: '主持回复：已读取本轮讨论。' }).waitFor(); await settled();
    assert.ok(requests.length > 0);
    const payload = JSON.stringify(requests.at(-1));
    assert.ok(payload.includes('selected-qa-swipe')); assert.ok(!payload.includes('old swipe'));
    assert.ok(payload.includes('QA character description')); assert.ok(payload.includes('QA editable host prompt'));
    assert.equal(await page.evaluate(() => SillyTavern.getContext().chat.filter(m => m.is_user).length), 0);
  });
  const firstChat = await page.evaluate(() => SillyTavern.getContext().chatId);
  await check('handoff preview edits, append/replace, no automatic send', async () => {
    await page.evaluate(() => LanternHost.close());
    await page.locator('#send_textarea').fill('酒馆原草稿');
    await open();
    await host.locator('[data-action=preview]').last().click();
    await host.locator('#lh-handoff').fill('手动确认后的内容');
    await host.locator('[data-action=handoff][data-mode=append]').click();
    await host.locator('.lh-backdrop').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#send_textarea').inputValue(), '酒馆原草稿\n\n手动确认后的内容');
    await open(); await host.locator('[data-action=preview-draft]').click();
    await host.locator('#lh-handoff').fill('替换内容'); await host.locator('[data-action=handoff][data-mode=replace]').click();
    await host.locator('.lh-backdrop').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#send_textarea').inputValue(), '替换内容');
    assert.equal(await page.evaluate(() => SillyTavern.getContext().chat.filter(m => m.is_user).length), 0);
    await open();
  });
  await check('different Tavern chats isolate records and recover server history', async () => {
    await page.evaluate(async () => SillyTavern.getContext().openCharacterChat('Lantern-QA-second-chat'));
    await page.waitForTimeout(1000); assert.equal(await host.locator('.lh-message').count(), 0);
    await host.locator('#lh-input').fill('第二局的草稿'); await page.waitForTimeout(1000);
    await page.evaluate(async id => SillyTavern.getContext().openCharacterChat(id), firstChat); await page.waitForTimeout(1000);
    assert.equal(await host.locator('.lh-message').count(), 2);
    assert.equal(await host.locator('#lh-input').inputValue(), '');
  });
  await check('refresh restores host messages, draft, handoff and global model prompt', async () => {
    await host.locator('#lh-input').fill('刷新恢复草稿'); await page.waitForTimeout(1000);
    await page.reload({ waitUntil: 'domcontentloaded' }); await ready();
    await page.evaluate(async avatar => { const ctx = SillyTavern.getContext(); await ctx.selectCharacterById(ctx.characters.findIndex(c => c.avatar === avatar)); }, avatar);
    await page.waitForTimeout(1000); await open();
    assert.equal(await host.locator('.lh-message').count(), 2); assert.equal(await host.locator('#lh-input').inputValue(), '刷新恢复草稿');
    await host.locator('.lh-nav [data-tab=settings]').click();
    assert.equal(await host.locator('#lh-prompt').inputValue(), 'QA editable host prompt');
    assert.equal(await host.locator('[data-profile=model]').inputValue(), 'local-qa-model');
    await host.locator('[data-tab=chat]').click();
  });
  await check('save failure is visible, local draft survives reload, retry confirms server', async () => {
    await page.route('**/api/chats/save', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"QA offline"}' }));
    await host.locator('#lh-input').fill('离线时仍保留的草稿');
    await host.locator('[data-action=retry-save]').waitFor();
    await page.reload({ waitUntil: 'domcontentloaded' }); await ready();
    await page.evaluate(async avatar => { const ctx = SillyTavern.getContext(); await ctx.selectCharacterById(ctx.characters.findIndex(c => c.avatar === avatar)); }, avatar);
    await page.waitForTimeout(800); await open();
    assert.equal(await host.locator('#lh-input').inputValue(), '离线时仍保留的草稿');
    await page.unroute('**/api/chats/save'); await host.locator('[data-action=retry-save]').click();
    await host.locator('[data-action=retry-save]').waitFor({ state: 'hidden' });
  });
  await check('stop generation and retry a failed request', async () => {
    mode = 'slow'; await host.locator('#lh-input').fill('停止测试'); await host.locator('.lh-composer').getByRole('button', { name: '发送', exact: true }).click();
    await host.locator('.lh-composer').getByRole('button', { name: '停止', exact: true }).click(); await settled();
    assert.equal(await host.locator('.lh-assistant').last().locator('header span').textContent(), '已停止');
    mode = 'error'; await host.locator('[data-action=retry]').last().click(); await settled();
    assert.equal(await host.locator('.lh-assistant').last().locator('header span').textContent(), '未完成');
    mode = 'normal'; await host.locator('[data-action=retry]').last().click(); await settled();
    assert.equal(await host.locator('.lh-assistant').last().locator('header span').textContent(), '');
  });
  await check('inline editing cancels, branches at original message, preserves version history', async () => {
    await host.locator('#lh-input').fill('底部草稿保持原样');
    await host.locator('[data-action=edit-message]').first().click();
    const editor = host.locator('.lh-inline-editor');
    await editor.locator('textarea').fill('取消的修改'); await editor.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await host.locator('.lh-user .lh-message-text').first().innerText(), '验收：这是独立主持对话。');
    await host.locator('[data-action=edit-message]').first().click();
    await host.locator('.lh-inline-editor textarea').fill('原位编辑后的第一条消息');
    await host.locator('.lh-inline-editor').getByRole('button', { name: '发送', exact: true }).click(); await settled();
    assert.equal(await host.locator('.lh-message').count(), 2);
    assert.equal(await host.locator('.lh-user .lh-message-text').innerText(), '原位编辑后的第一条消息');
    assert.equal(await host.locator('#lh-input').inputValue(), '底部草稿保持原样');
    const request = JSON.stringify(requests.at(-1)); assert.ok(!request.includes('验收：这是独立主持对话。')); assert.ok(request.includes('原位编辑后的第一条消息'));
    await host.locator('.lh-user [data-action=version-prev]').click();
    assert.equal(await host.locator('.lh-message').count(), 4);
    await host.locator('.lh-user [data-action=version-next]').first().click();
    assert.equal(await host.locator('.lh-message').count(), 2);
  });
  await screenshot('desktop-chat.png');
  await check('full text search, original source viewer, import and attach', async () => {
    await host.locator('[data-tab=documents]').click();
    await host.locator('#lh-doc-search').fill('骰子');
    await host.locator('[data-action=doc-open]').first().waitFor();
    await host.locator('[data-action=doc-open]').first().click();
    assert.ok((await host.locator('.lh-doc-content').innerText()).length > 50);
    await host.locator('#lh-import').setInputFiles({ name: 'qa-import.md', mimeType: 'text/markdown', buffer: Buffer.from('# 验收资料\nQA-unique-import-body') });
    await host.locator('#lh-doc-search').fill('QA-unique-import-body');
    await host.getByRole('button', { name: 'qa-import.md', exact: true }).click();
    await host.locator('[data-action=doc-attach]').click();
    await host.locator('[data-tab=chat]').click();
    await host.locator('#lh-input').fill('资料附加测试'); await host.locator('.lh-composer').getByRole('button', { name: '发送', exact: true }).click(); await settled();
    assert.ok(JSON.stringify(requests.at(-1)).includes('QA-unique-import-body'));
  });
  await check('Markdown headings, tables, code, raw source and sanitization', async () => {
    const reply = host.locator('.lh-assistant .lh-message-text').last();
    assert.equal(await reply.locator('h2').innerText(), '本轮结果'); assert.equal(await reply.locator('table').count(), 1);
    assert.equal((await reply.locator('pre code').innerText()).trim(), 'const result = 17;');
    assert.equal(await reply.locator('script').count(), 0); assert.equal(await page.evaluate(() => !!window.__lhUnsafe), false);
    await screenshot('desktop-markdown.png');
    await host.locator('[data-tab=documents]').click();
    if (!await host.locator('#lh-doc-search').isVisible()) await host.locator('[data-action=doc-back]').click();
    await host.locator('#lh-doc-search').fill('骰子');
    await host.locator('[data-action=doc-open]').first().waitFor(); await host.locator('[data-action=doc-open]').first().click();
    assert.ok(await host.locator('.lh-doc-content h1').count());
    await host.locator('[data-action=doc-source]').click(); assert.ok((await host.locator('.lh-doc-content pre').innerText()).startsWith('#'));
    await host.locator('[data-action=doc-source]').click(); await host.locator('[data-tab=chat]').click();
  });
  await check('automatic context compaction retains history and actually sends a summary', async () => {
    await host.locator('.lh-nav [data-tab=settings]').click();
    await host.locator('[data-profile=capacityMode]').selectOption('manual');await host.locator('[data-profile=contextWindow]').fill('32768'); await host.locator('[data-profile=maxTokens]').fill('256');
    await host.locator('[data-action=profile-save]').click(); await host.locator('.lh-feedback').filter({ hasText: '已保存' }).waitFor();
    await host.locator('[data-tab=chat]').click();
    await page.evaluate(async () => {
      const app = await (await import('/scripts/extensions/third-party/lantern-host-extension/index.js')).enable();
      const { appendMessage } = await import('/scripts/extensions/third-party/lantern-host-extension/src/conversation.js');
      for (let n = 0; n < 20; n++) appendMessage(app.session, { id: crypto.randomUUID(), role: n % 2 ? 'assistant' : 'user', content: `${n}: ${'past-fact '.repeat(280)}`, status: 'complete' });
      await app.persist(); app.render();
    });
    const before = requests.length;
    await host.locator('#lh-input').fill('自动压缩后继续'); await host.locator('.lh-composer').getByRole('button', { name: '发送', exact: true }).click(); await settled();
    const state = await page.evaluate(async () => { const app = await (await import('/scripts/extensions/third-party/lantern-host-extension/index.js')).enable(); return { compactions: app.session.compactions.length, nodes: app.session.conversation.nodes.length, error: app.error }; });
    assert.ok(state.compactions > 0, JSON.stringify(state)); assert.ok(state.nodes >= 26);
    assert.equal(requests.length - before, 2); assert.ok(JSON.stringify(requests.at(-1)).includes('较早主持对话摘要'));
  });
  await check('slash menu, plan and goal run state, custom command configuration', async () => {
    await host.locator('#lh-input').fill('/'); await host.locator('.lh-command-menu').waitFor();
    await host.locator('[data-action=command-insert][data-name=plan]').click();
    await host.locator('.lh-composer').getByRole('button', { name: '发送', exact: true }).click();
    await host.locator('.lh-session-mode').filter({ hasText: '计划模式' }).waitFor();
    await host.locator('#lh-input').fill('/goal 完成当前任务'); await host.locator('.lh-composer').getByRole('button', { name: '发送', exact: true }).click();
    await host.locator('.lh-session-mode').filter({ hasText: '完成当前任务' }).waitFor();
    await host.locator('.lh-nav [data-tab=settings]').click(); await host.locator('[data-action=command-new]').click();
    const custom = host.locator('.lh-custom-command').last();
    await custom.locator('[data-command-field=name]').fill('recap'); await custom.locator('[data-command-field=template]').fill('请总结：{input}');
    await host.locator('[data-action=commands-save]').click(); await host.locator('.lh-alert').filter({ hasText: '指令设置已保存' }).waitFor();
    await host.locator('[data-tab=chat]').click(); await host.locator('#lh-input').fill('/recap 本轮');
    await host.locator('.lh-composer').getByRole('button', { name: '发送', exact: true }).click(); await settled();
    const payload = JSON.stringify(requests.at(-1)); assert.ok(payload.includes('请总结：本轮')); assert.ok(payload.includes('计划模式')); assert.ok(payload.includes('完成当前任务'));
  });
  await check('minimize, close and Esc keep a single request alive, preserve reading position, and accept same-chat messages',async()=>{
    await host.locator('[data-tab=chat]').click();await page.evaluate(async()=>{const a=await(await import('/scripts/extensions/third-party/lantern-host-extension/index.js')).enable();a.session.mode='chat';a.settings.autoCompact=false;a.render();});mode='keepalive';
    for(const control of ['minimize','close','escape']){
      const requestCount=requests.length;heldFinish=null;
      await host.locator('#lh-input').fill('收起保活测试 '+control);await host.locator('.lh-composer').getByRole('button',{name:'发送',exact:true}).click();await host.locator('.lh-assistant').last().locator('.lh-message-text').getByText('主持回复：已读取本轮讨论。').waitFor();
      await host.locator('.lh-messages').evaluate(n=>{n.scrollTop=120;});const top=await host.locator('.lh-messages').evaluate(n=>n.scrollTop);
      if(control==='escape')await page.keyboard.press('Escape');else await host.locator('[data-window='+control+']').click();
      assert.equal(await page.evaluate(()=>LanternHost.getStatus().busy),true);assert.equal(await host.locator('.lh-launcher').getAttribute('data-state'),'running');
      await page.evaluate(async()=>{const c=SillyTavern.getContext();c.chat.push({name:'QA',is_user:false,mes:'正文新增：店主说仓库今晚停电。'});await c.eventSource.emit(c.eventTypes.MESSAGE_RECEIVED,c.chat.length-1);await c.eventSource.emit(c.eventTypes.CHAT_CHANGED,c.chatId);});
      assert.equal(await page.evaluate(()=>LanternHost.getStatus().busy),true);assert.equal(requests.length,requestCount+1);assert.ok(heldFinish);heldFinish();await settled();
      assert.ok(['complete','saving'].includes(await host.locator('.lh-launcher').getAttribute('data-state')));await host.locator('.lh-launcher').click();
      assert.equal(await host.locator('.lh-assistant').last().locator('header span').textContent(),'');assert.ok(Math.abs(await host.locator('.lh-messages').evaluate(n=>n.scrollTop)-top)<2);assert.equal(requests.length,requestCount+1);
    }mode='normal';
  });
  await check('reloading a hidden running workspace restores its checkpoint and resumes the same turn',async()=>{
    mode='keepalive';heldFinish=null;await host.locator('#lh-input').fill('暂停页面后恢复同一轮');await host.locator('.lh-composer').getByRole('button',{name:'发送',exact:true}).click();await host.locator('.lh-assistant').last().locator('.lh-message-text').getByText('主持回复：已读取本轮讨论。').waitFor();
    const turn=await page.evaluate(async()=>{const a=await(await import('/scripts/extensions/third-party/lantern-host-extension/index.js')).enable();return{userId:a.session.messages.at(-2).id,binding:a.sessions.current(a.key).binding,chatId:SillyTavern.getContext().chatId};});
    await host.locator('[data-window=close]').click();await page.waitForFunction(async()=>{const a=await(await import('/scripts/extensions/third-party/lantern-host-extension/index.js')).enable();return !a.syncing;});await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));
    await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>!!window.LanternHost);await page.evaluate(async({avatar,chatId})=>{const c=SillyTavern.getContext();await c.selectCharacterById(c.characters.findIndex(x=>x.avatar===avatar));await c.openCharacterChat(chatId);LanternHost.open();},{avatar,chatId:turn.chatId});
    await page.waitForFunction(async()=>{const a=await(await import('/scripts/extensions/third-party/lantern-host-extension/index.js')).enable();return ['interrupted','failed','cancelled'].includes(a.session.messages.at(-1)?.status);});mode='normal';await host.locator('[data-action=retry]').last().click();await settled();
    const restored=await page.evaluate(async()=>{const a=await(await import('/scripts/extensions/third-party/lantern-host-extension/index.js')).enable();return{userId:a.session.messages.at(-2).id,binding:a.sessions.current(a.key).binding,status:a.session.messages.at(-1).status};});assert.equal(restored.userId,turn.userId);assert.equal(restored.binding.campaignId,turn.binding.campaignId);assert.equal(restored.binding.branchId,turn.binding.branchId);assert.equal(restored.status,'complete');
  });
  await check('only the four current agent prompts are editable',async()=>{await host.locator('[data-tab=settings]').click();assert.equal(await host.locator('[data-agent-prompt]').count(),4);assert.equal(await host.locator('[data-agent-prompt=character]').count(),0);await host.locator('[data-tab=chat]').click();});
  await check('mobile portrait, keyboard-sized viewport, minimize/restore and landscape', async () => {
    for (const [width, height, label] of [[390,844,'mobile-portrait.png'], [390,440,'mobile-keyboard.png'], [844,390,'mobile-landscape.png']]) {
      await page.setViewportSize({ width, height }); await page.waitForTimeout(250);
      const box = await host.locator('.lh-panel').boundingBox();
      assert.ok(box.x >= -1 && box.y >= -1 && box.x + box.width <= width + 1 && box.y + box.height <= height + 1, JSON.stringify({ width,height,box }));
      const input = await host.locator('#lh-input').boundingBox(); assert.ok(input.y + input.height <= height);
      await screenshot(label);
    }
    await host.locator('[data-window=minimize]').click(); await host.locator('.lh-launcher').waitFor();
    await host.locator('.lh-launcher').click(); await host.locator('.lh-backdrop').waitFor();
    assert.ok(await host.locator('.lh-message').count() >= 4);
    await page.setViewportSize({ width: 390, height: 844 });
    await host.locator('.lh-nav [data-tab=settings]').click(); await screenshot('mobile-settings.png');
    await host.locator('[data-tab=documents]').click();
    if (!await host.locator('#lh-doc-search').isVisible()) await host.locator('[data-action=doc-back]').click();
    await host.locator('#lh-doc-search').fill('骰子');
    await host.locator('[data-action=doc-open]').first().waitFor(); await host.locator('[data-action=doc-open]').first().click();
    await screenshot('mobile-documents.png'); await host.locator('[data-action=doc-back]').click();
    assert.ok(await host.locator('#lh-doc-search').isVisible());
  });
  await check('mobile touch browser opens, types, minimizes and restores the same build', async () => {
    const touchContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    try {
      const touchPage = await touchContext.newPage();
      await serveSource(touchPage);await touchPage.goto(process.env.TAVERN_URL || 'http://127.0.0.1:8000/', { waitUntil: 'domcontentloaded' });
      await touchPage.waitForFunction(() => !!window.LanternHost);
      await touchPage.evaluate(async avatar => { const ctx = SillyTavern.getContext(); await ctx.selectCharacterById(ctx.characters.findIndex(c => c.avatar === avatar)); LanternHost.open(); }, avatar);
      await touchPage.waitForTimeout(800);
      await touchPage.locator('#lh-input').tap(); await touchPage.locator('#lh-input').fill('触摸输入草稿');
      await touchPage.locator('[data-window=minimize]').tap(); await touchPage.locator('.lh-launcher').tap();
      assert.equal(await touchPage.locator('#lh-input').inputValue(), '触摸输入草稿');
      await touchPage.waitForTimeout(300);
      await touchPage.screenshot({ path: fileURLToPath(new URL('mobile-touch.png', root)) });
      await touchPage.setViewportSize({ width: 844, height: 390 }); await touchPage.waitForTimeout(300);
      const box = await touchPage.locator('.lh-panel').boundingBox();
      const viewport = await touchPage.evaluate(() => ({ inner: [innerWidth,innerHeight], visual: [visualViewport.width,visualViewport.height,visualViewport.offsetLeft,visualViewport.offsetTop,visualViewport.scale], rootHeight: document.querySelector('#lantern-host-root').style.getPropertyValue('--lh-height'), body: [getComputedStyle(document.body).zoom,getComputedStyle(document.body).transform,getComputedStyle(document.body).height] }));
      await touchPage.screenshot({ path: fileURLToPath(new URL('mobile-touch-landscape.png', root)) });
      assert.ok(box.y >= -1 && box.y + box.height <= 391, JSON.stringify({box,viewport}));
    } finally { await touchContext.close(); }
  });
  assert.deepEqual(errors.filter(e => /lantern|lh-/i.test(e)), []);
} catch (error) {
  console.log('REQUEST_COUNT', requests.length);
  results.push({ name: 'integration failure', pass: false, error: error.message });
  await screenshot('failure.png').catch(() => {}); console.error(error.stack); process.exitCode = 1;
} finally {
  // Remove only this run's owned QA character/chats and temporary namespace settings.
  if (backup) await page.evaluate(async ({ avatar, backup }) => {
    const ctx = SillyTavern.getContext();
    const entry = await import('/scripts/extensions/third-party/lantern-host-extension/index.js'); entry.disable();
    await new Promise(resolve => setTimeout(resolve, 1000));
    if (avatar?.startsWith('Lantern-QA-')) await fetch('/api/characters/delete', { method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar, delete_chats: true }) });
    const current = await (await fetch('/api/settings/get', { method: 'POST', headers: ctx.getRequestHeaders(), body: '{}' })).json();
    const saved = JSON.parse(current.settings);
    if (backup.namespace === undefined) delete saved.extension_settings.lantern_host; else saved.extension_settings.lantern_host = backup.namespace;
    saved.active_character = backup.active_character; saved.active_group = backup.active_group;
    await fetch('/api/settings/save', { method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify(saved) });
  }, { avatar, backup }).catch(error => { console.error('QA cleanup failed:', error.message); process.exitCode = 1; });
  await writeFile(new URL('browser-results.json', root), JSON.stringify({ date: new Date().toISOString(), host: 'SillyTavern 1.19.0', modelEndpoint: 'local deterministic HTTP fixture via real Tavern backend', results }, null, 2));
  await browser.close(); upstream.closeAllConnections(); upstream.close();
}
