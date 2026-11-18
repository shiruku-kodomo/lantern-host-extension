function validateNode(node) {
  if (!node?.id || !['user', 'assistant'].includes(node.role) || typeof node.content !== 'string') throw new Error('主持消息记录损坏，请先导出备份。');
}
export function hydrateConversation(session) {
  if (!session.conversation) {
    let parentId = null;
    const selected = {}, nodes = [];
    for (const message of session.messages || []) {
      validateNode(message);
      const node = { ...message, parentId };
      nodes.push(node); selected[parentId ?? 'root'] = node.id; parentId = node.id;
    }
    session.conversation = { version: 1, nodes, selected };
  }
  const tree = session.conversation;
  if (tree.version !== 1 || !Array.isArray(tree.nodes) || !tree.selected || typeof tree.selected !== 'object') throw new Error('主持分支记录格式无效。');
  const ids = new Set();
  for (const node of tree.nodes) {
    validateNode(node);
    if (ids.has(node.id)) throw new Error('主持消息编号重复。');
    if (node.parentId != null && !ids.has(node.parentId)) throw new Error('主持分支缺少上级消息或出现循环。');
    ids.add(node.id);
  }
  return activeMessages(session);
}
export function activeMessages(session) {
  const tree = session.conversation;
  if (!tree) return hydrateConversation(session);
  const byParent = new Map();
  for (const node of tree.nodes) { const key = node.parentId ?? 'root'; if (!byParent.has(key)) byParent.set(key, []); byParent.get(key).push(node); }
  const path = [], visited = new Set();
  let parent = 'root';
  while (byParent.has(parent)) {
    const children = byParent.get(parent);
    const node = children.find(n => n.id === tree.selected[parent]) || children.at(-1);
    if (visited.has(node.id)) throw new Error('主持分支出现循环。');
    visited.add(node.id); path.push(node); parent = node.id;
  }
  session.messages = path;
  return path;
}
export function appendMessage(session, message, parentId) {
  if (!session.conversation) hydrateConversation(session);
  const path = activeMessages(session);
  if (parentId === undefined) parentId = path.at(-1)?.id ?? null;
  if (parentId !== null && !session.conversation.nodes.some(n => n.id === parentId)) throw new Error('要继续的消息不存在。');
  validateNode(message);
  const node = { ...message, parentId };
  session.conversation.nodes.push(node);
  session.conversation.selected[parentId ?? 'root'] = node.id;
  activeMessages(session);
  return node;
}
export function editUserMessage(session, id, text) {
  if (!text.trim()) throw new Error('消息不能为空。');
  if (!session.conversation) hydrateConversation(session);
  const node = session.messages.find(n => n.id === id && n.role === 'user');
  if (!node) throw new Error('要编辑的消息不在当前分支中。');
  return appendMessage(session, { id: crypto.randomUUID(), role: 'user', content: text.trim(), status: 'complete' }, node.parentId);
}
export function versionsOf(session, id) {
  if (!session.conversation) hydrateConversation(session);
  const current = session.conversation.nodes.find(n => n.id === id);
  if (!current) return { index: 0, total: 0, siblings: [] };
  const siblings = session.conversation.nodes.filter(n => n.parentId === current.parentId && n.role === current.role);
  return { index: siblings.findIndex(n => n.id === id), total: siblings.length, siblings };
}
export function switchVersion(session, id, delta) {
  const { index, siblings } = versionsOf(session, id);
  const target = siblings[index + delta];
  if (!target) return false;
  session.conversation.selected[target.parentId ?? 'root'] = target.id;
  session.editDraft = null;
  activeMessages(session);
  return true;
}
export function compactionFor(session) {
  const ids = session.messages.map(m => m.id);
  return (session.compactions || []).filter(c => typeof c.summary === 'string' && Array.isArray(c.coveredIds) && c.coveredIds.length && c.coveredIds.every((id, i) => id === ids[i]))
    .sort((a, b) => b.coveredIds.length - a.coveredIds.length || b.createdAt - a.createdAt)[0];
}
