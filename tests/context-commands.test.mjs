import test from 'node:test';
import assert from 'node:assert/strict';
import { emptySession, requestMessages } from '../src/core.js';
import { appendMessage, editUserMessage } from '../src/conversation.js';
import { ContextManager, estimateTokens, contextBudget } from '../src/context.js';
import { parseCommand, validateCommands, commandList, expandCommand, updateGoal } from '../src/commands.js';

test('automatic compaction preserves original tree, keeps recent turns, and invalidates on branch edits', async () => {
  const session = emptySession();
  for (let n = 0; n < 20; n++) appendMessage(session, { id: `m${n}`, role: n % 2 ? 'assistant' : 'user', content: `${n}: ${'historical fact '.repeat(100)}`, status: 'complete' });
  const calls = [];
  const manager = new ContextManager({ chat: async (...args) => { calls.push(args); return 'Confirmed earlier facts: location A, value 17. Unresolved decision B.'; } });
  const input = { settings: { systemPrompt: 'host', autoCompact: true }, session, context: null };
  const result = await manager.prepare(input, { contextWindow: 12000, maxTokens: 1000 });
  assert.ok(calls.length>=1);for(const [profile,messages]of calls)assert.ok(estimateTokens(messages)<contextBudget(profile).inputLimit); assert.ok(result.compaction);
  assert.ok(result.used < result.compaction.estimatedBefore); assert.equal(session.conversation.nodes.length, 20);
  session.compactions.push(result.compaction);
  assert.ok(requestMessages(input).some(m => m.content.includes('Confirmed earlier facts')));
  editUserMessage(session, 'm0', 'different branch');
  assert.ok(!requestMessages(input).some(m => m.content.includes('Confirmed earlier facts')));
});

test('compaction is cancellable and static documents are never silently discarded', async () => {
  const session = emptySession();
  for (let n = 0; n < 12; n++) appendMessage(session, { id: String(n), role: n % 2 ? 'assistant' : 'user', content: 'fact '.repeat(200), status: 'complete' });
  const controller = new AbortController(); controller.abort();
  const manager = new ContextManager({ chat: async () => { throw new Error('must not call'); } });
  await assert.rejects(manager.prepare({ settings: { systemPrompt: '' }, session }, { contextWindow: 4096, maxTokens: 512 }, { signal: controller.signal, force: true }), /abort/i);
  const oversized = new ContextManager({ chat: async () => 'short summary' });
  await assert.rejects(oversized.prepare({ settings: { systemPrompt: '' }, session, documents: [{ path: 'large.md', content: 'x'.repeat(30000) }] }, { contextWindow: 4096, maxTokens: 512 }, { force: true }), /仍超出/);
  assert.equal(session.compactions.length, 0);
  assert.ok(estimateTokens([{ content: '中文' }]) > 0);
});

test('slash commands parse multiline text, honor settings and never execute code', () => {
  assert.deepEqual(parseCommand('/plan make a plan\nwith steps'), { name: 'plan', argument: 'make a plan\nwith steps' });
  assert.equal(parseCommand('normal message'), null); assert.equal(parseCommand('//literal'), null);
  const commands = validateCommands([{ name: '/recap', template: 'Summarize: {input}' }]);
  assert.equal(expandCommand(commands[0], 'this chat'), 'Summarize: this chat');
  assert.throws(() => validateCommands([{ name: 'plan', template: 'x' }]), /重复/);
  assert.throws(() => validateCommands([{ name: 'bad name', template: 'x' }]));
  assert.ok(!commandList({ disabledCommands: ['plan'], customCommands: commands }).some(c => c.name === 'plan'));
});

test('goal lifecycle persists as local run state and affects prompts only while active', () => {
  const session = emptySession(); updateGoal(session, 'Finish the mission'); session.mode = 'plan';
  let messages = requestMessages({ settings: { systemPrompt: 'host' }, session });
  assert.ok(messages.some(m => m.content.includes('Finish the mission'))); assert.ok(messages.some(m => m.content.includes('计划模式')));
  updateGoal(session, 'pause'); messages = requestMessages({ settings: { systemPrompt: 'host' }, session });
  assert.ok(!messages.some(m => m.content.includes('Finish the mission')));
  updateGoal(session, 'resume'); updateGoal(session, 'done'); assert.equal(session.goal.status, 'complete'); assert.equal(session.goalHistory.length, 4);
});
