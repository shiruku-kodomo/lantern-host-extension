import test from 'node:test';
import assert from 'node:assert/strict';
import { currentChatKey, selectedHistory, requestMessages, emptySession, composeInput, safePath } from '../src/core.js';
import { ModelClient, connectionPayload, extractModels, readSse } from '../src/provider.js';
import { SessionRepository } from '../src/sessions.js';
import { TavernBridge } from '../src/bridge.js';
import { DocumentLibrary } from '../src/documents.js';
import { readFile } from 'node:fs/promises';

test('chat identity includes account, avatar and chat file; context uses selected swipe', () => {
  const context = { chatId: 'one', characterId: 0, characters: [{ avatar: 'a.png' }] };
  assert.notEqual(currentChatKey(context, 'A'), currentChatKey(context, 'B'));
  assert.notEqual(currentChatKey(context), currentChatKey({ ...context, chatId: 'two' }));
  assert.notEqual(currentChatKey(context), currentChatKey({ ...context, characters: [{ avatar: 'b.png' }] }));
  assert.equal(currentChatKey({}), null);
  const history = [{ mes: 'hidden', is_system: true }, { is_user: true, mes: 'input' }, { mes: 'old', swipes: ['old', 'selected'], swipe_id: 1 }];
  assert.deepEqual(selectedHistory(history, 1).map(m => m.content), ['selected']);
  assert.deepEqual(selectedHistory(history, 0), []);
});

test('request excludes incomplete assistant messages and can disable Tavern context', () => {
  const session = emptySession();
  session.contextEnabled = false;
  session.messages = [{ role: 'user', content: 'question' }, { role: 'assistant', content: 'partial', status: 'failed' }];
  const messages = requestMessages({ settings: { systemPrompt: 'host' }, session, context: { secret: 'not included' }, documents: [{ path: 'rules.md', content: 'rule' }] });
  assert.deepEqual(messages.map(m => m.content), ['host', '【资料 rules.md】\nrule', 'question']);
});

test('handoff requires an explicit choice when composer contains a draft', () => {
  assert.throws(() => composeInput('old', 'new'), /追加或替换/);
  assert.equal(composeInput('old', 'new', 'append'), 'old\n\nnew');
  assert.equal(composeInput('old', 'new', 'replace'), 'new');
  assert.throws(() => composeInput('', '  '));
  assert.throws(() => safePath('../escape.md'));
});

test('independent connection payload never references Tavern secret ids', () => {
  assert.deepEqual(connectionPayload({ protocol: 'openai', baseUrl: 'https://example.test/v1/', apiKey: 'test-only' }), { chat_completion_source: 'openai', reverse_proxy: 'https://example.test/v1', proxy_password: 'test-only' });
  assert.equal(connectionPayload({ protocol: 'anthropic', baseUrl: 'https://example.test' }).reverse_proxy, 'https://example.test/v1');
  assert.equal(connectionPayload({ protocol: 'google', baseUrl: 'https://example.test/v1beta' }).reverse_proxy, 'https://example.test');
  assert.throws(() => connectionPayload({ baseUrl: 'javascript:alert(1)' }));
  assert.deepEqual(extractModels({ models: [{ name: 'models/a' }, { name: 'models/a' }, { id: 'b' }] }), ['a', 'b']);
  assert.equal(connectionPayload({ protocol: 'openai', baseUrl: 'https://example.test/v1/chat/completions' }).reverse_proxy, 'https://example.test/v1');
});
test('root endpoints prefer a verified standard API prefix; custom bases are preserved', async () => {
  const candidates = [];
  const client = new ModelClient({ headers: () => ({}) }, async (url, init) => { const p = JSON.parse(init.body); candidates.push(p.reverse_proxy); return Response.json({ data: [{ id: 'model' }] }); });
  const profile = { protocol: 'openai', baseUrl: 'https://example.test' };
  assert.equal((await client.resolve(profile, undefined, true)).baseUrl, 'https://example.test/v1');
  assert.deepEqual(candidates, ['https://example.test/v1']);
  assert.equal((await client.resolve({ ...profile, baseUrl: 'https://example.test/custom/api' })).baseUrl, 'https://example.test/custom/api');
});

function stream(parts) {
  return new Response(new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(new TextEncoder().encode(part)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
}
test('SSE parser survives split CRLF and UTF-8 events; incomplete streams fail', async () => {
  const events = [];
  await readSse(stream(['data: {"text":', '"你好"}\r', '\n\r\ndata: [DONE]\n\n']), data => events.push(data));
  assert.deepEqual(events, [{ text: '你好' }]);
  const bridge = { headers: () => ({}) };
  const profile = { model: 'test-model', baseUrl: 'https://example.test/v1', protocol: 'openai' };
  const client = new ModelClient(bridge, async () => stream(['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n']));
  await assert.rejects(client.chat(profile, []), error => error.partial === 'partial');
});

test('real model client accumulates reply and honors cancellation and upstream errors', async () => {
  const profile = { model: 'test-model', baseUrl: 'https://example.test/v1', protocol: 'openai' };
  let request;
  const client = new ModelClient({ headers: () => ({ 'x-test': 'ok' }) }, async (url, init) => {
    request = { url, ...JSON.parse(init.body) };
    return stream(['data: {"choices":[{"delta":{"content":"hello"}}]}\n\n', 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n']);
  });
  assert.equal(await client.chat(profile, [{ role: 'user', content: 'hi' }]), 'hello');
  assert.equal(request.proxy_password, '');
  assert.equal(request.stream, true);
  const headerless = new ModelClient({ headers: () => ({}) }, async () => new Response('data: {"choices":[{"delta":{"content":"headerless"},"finish_reason":"stop"}]}\n\n'));
  assert.equal(await headerless.chat(profile, []), 'headerless');
  const largeText = 'a'.repeat(6000);
  const largeChunk = new ModelClient({ headers: () => ({}) }, async () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: largeText }, finish_reason: 'stop' }] })}\n\n`));
  assert.equal(await largeChunk.chat(profile, []), largeText);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(client.chat(profile, [], { signal: abort.signal }), /abort/i);
  const failed = new ModelClient({ headers: () => ({}) }, async () => new Response('{"error":{"message":"bad key"}}', { status: 401 }));
  await assert.rejects(failed.chat(profile, []), /bad key/);
});

function memoryStore() {
  const records = new Map();
  return { get: async key => structuredClone(records.get(key)), put: async (key, value) => { records.set(key, structuredClone(value)); } };
}
test('unsynced draft restores even with same revision as server', async () => {
  const remote = emptySession(), store = memoryStore();
  const bridge = { key: () => 'a', savedSession: () => remote };
  const repo = new SessionRepository(bridge, store);
  const { session } = await repo.load('a'); session.draft = 'unsent';
  await repo.cache('a', session);
  const recovered = await new SessionRepository(bridge, store).load('a');
  assert.equal(recovered.session.draft, 'unsent'); assert.equal(recovered.dirty, true);
});

test('failed saves retain drafts; queue recovers and newer edits survive an in-flight save', async () => {
  let remote = null, fail = true, release;
  const store = memoryStore();
  const bridge = { key: () => 'a', savedSession: () => remote,
    saveSession: async (key, snapshot, base) => {
      assert.equal(base, JSON.stringify(remote));
      if (fail) throw new Error('offline');
      if (release !== false) await new Promise(resolve => { release = resolve; });
      remote = structuredClone(snapshot);
    } };
  const repo = new SessionRepository(bridge, store), { session } = await repo.load('a'); session.draft = 'first';
  await assert.rejects(repo.sync('a', session), /offline/);
  assert.equal((await store.get('chat:a')).session.draft, 'first');
  fail = false;
  const pending = repo.sync('a', session);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  session.draft = 'newer'; await repo.cache('a', session); release(); await pending;
  assert.equal((await store.get('chat:a')).session.draft, 'newer');
  assert.equal((await new SessionRepository(bridge, store).load('a')).session.draft, 'newer');
  release = false; await repo.sync('a', session);
  assert.equal(remote.draft, 'newer'); assert.equal((await store.get('chat:a')).dirty, false);
});

test('bridge refuses concurrent server changes, verifies swallowed failure, handles group metadata', async () => {
  let remote = null, ignored = true;
  const ctx = { chatId: 'one', characterId: 0, characters: [{ avatar: 'a.png' }], chatMetadata: {}, saveChat: async () => { if (!ignored) remote = structuredClone(ctx.chatMetadata.lantern_host); }, getRequestHeaders: () => ({}) };
  const calls = [];
  const bridge = new TavernBridge(() => ctx, async (url, init) => { calls.push({ url, payload: JSON.parse(init.body) }); return Response.json([{ chat_metadata: { lantern_host: remote } }]); });
  const session = emptySession(); session.draft = 'saved';
  await assert.rejects(bridge.saveSession(bridge.key(), session, 'null'), /尚未确认/);
  ignored = false; await bridge.saveSession(bridge.key(), session, 'null');
  remote.draft = 'another window';
  await assert.rejects(bridge.saveSession(bridge.key(), session, JSON.stringify(null)), /其他窗口/);
  ctx.groupId = 'group'; await bridge.readRemoteSession();
  assert.equal(calls.at(-1).url, '/api/chats/group/get'); assert.equal(calls.at(-1).payload.id, 'one');
});

test('bundled catalog matches original hashes and document search uses full text', async () => {
  const { createHash } = await import('node:crypto');
  const store = memoryStore();
  const library = new DocumentLibrary(store, new URL('../content/', import.meta.url), async url => new Response(await readFile(url)));
  await library.init();
  assert.ok(library.list().length > 400);
  for (const entry of library.list()) {
    const doc = await library.read(entry.id);
    assert.equal(createHash('sha256').update(doc.content).digest('hex'), entry.sha256);
  }
  assert.ok((await library.search('骰子')).length > 0);
  await library.importFiles([{ name: 'custom.md', size: 10, text: async () => '# custom\nrare-search-term' }]);
  assert.equal((await library.search('rare-search-term'))[0].path, '导入资料/custom.md');
  await assert.rejects(library.importFiles([{ name: 'broken.json', size: 1, text: async () => '{' }]));
});
