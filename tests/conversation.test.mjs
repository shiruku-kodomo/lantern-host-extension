import test from 'node:test';
import assert from 'node:assert/strict';
import { emptySession, readSession } from '../src/core.js';
import { appendMessage, editUserMessage, switchVersion, versionsOf, hydrateConversation } from '../src/conversation.js';
const message = (id, role, content = id) => ({ id, role, content, status: 'complete' });
test('editing an earlier message creates a sibling branch and preserves later old history', () => {
  const session = emptySession();
  appendMessage(session, message('u1', 'user')); appendMessage(session, message('a1', 'assistant'));
  appendMessage(session, message('u2', 'user')); appendMessage(session, message('a2', 'assistant'));
  const revised = editUserMessage(session, 'u1', 'edited');
  appendMessage(session, message('new-a', 'assistant'));
  assert.deepEqual(session.messages.map(m => m.content), ['edited', 'new-a']);
  assert.equal(versionsOf(session, revised.id).total, 2);
  switchVersion(session, revised.id, -1);
  assert.deepEqual(session.messages.map(m => m.id), ['u1','a1','u2','a2']);
  switchVersion(session, 'u1', 1);
  assert.deepEqual(session.messages.map(m => m.id), [revised.id,'new-a']);
  const restored = readSession(JSON.parse(JSON.stringify(session)));
  restored.messages.at(-1).content = 'stream update';
  assert.equal(restored.conversation.nodes.find(n => n.id === 'new-a').content, 'stream update');
});
test('retry forks assistant versions without deleting branches, legacy flat records migrate', () => {
  const session = readSession({ ...emptySession(), messages: [message('u', 'user'), message('a', 'assistant')] });
  appendMessage(session, message('retry', 'assistant'), 'u');
  assert.deepEqual(session.messages.map(m => m.id), ['u','retry']);
  switchVersion(session, 'retry', -1); assert.equal(session.messages.at(-1).id, 'a');
  assert.equal(session.conversation.nodes.length, 3);
  assert.throws(() => editUserMessage(session, 'u', '   '));
});
test('corrupt branches fail safely instead of silently rewriting the conversation', () => {
  const session = { ...emptySession(), conversation: { version: 1, nodes: [{ ...message('a', 'user'), parentId: 'a' }], selected: {} } };
  assert.throws(() => hydrateConversation(session), /循环/);
});
