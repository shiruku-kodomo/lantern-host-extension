import { hydrateConversation, compactionFor } from './conversation.js';
import { normalizeAgentPrompts } from './agent-prompts.js';
export const NAMESPACE = 'lantern_host';
export const DEFAULT_PROMPT = '你是《灯火之外》的主持。原策划决定机制，正式内容提供资料，本局数据库记录实际事实。按依赖分派判定、分析、情报与角色Agent；只用真实工具返回结算，不能编造骰子或数值。开场按规则自动建档；缺失内容通过生成工具补齐一次并保存。设置讨论、查看记录不产生游戏动作。重大选择交还玩家，正文由酒馆连接负责。';
export function emptySession() {
  return { version: 1, revision: 0, messages: [], draft: '', handoff: '', selectedDocs: [], contextEnabled: true, pending: null, updatedAt: 0, compactions: [] };
}
export function readSession(raw) {
  if (raw == null) return emptySession();
  if (raw.version !== 1 || !Array.isArray(raw.messages) || !Number.isInteger(raw.revision)) throw new Error('主持记录格式损坏，请先导出备份后恢复。');
  if (raw.messages.some(m => !m.id || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string')) throw new Error('主持消息记录损坏。');
  const session = { ...emptySession(), ...structuredClone(raw) };
  hydrateConversation(session);
  return session;
}
export function normalizeSettings(raw = {}) {
  const legacyDefault='你是《灯火之外》的主持助手。与玩家讨论当前游戏，依据提供的策划资料和本局记录回答。明确区分资料事实与建议。当前阶段尚未接入正式多 Agent 判定与数值结算工具，不得宣称已经调用骰子、扣除物品或修改本局数值。';
  return {
    version: 1, systemPrompt: typeof raw.systemPrompt === 'string' && raw.systemPrompt!==legacyDefault ? raw.systemPrompt : DEFAULT_PROMPT,
    activeProfileId: raw.activeProfileId || '', contextLimit: Math.max(1, Math.min(200, Number(raw.contextLimit) || 30)),
    autoCompact: raw.autoCompact !== false,
    agentPrompts: normalizeAgentPrompts(raw), agentPromptVersion: 2,
    disabledCommands: Array.isArray(raw.disabledCommands) ? [...raw.disabledCommands] : [],
    customCommands: Array.isArray(raw.customCommands) ? structuredClone(raw.customCommands) : [],
    profiles: Array.isArray(raw.profiles) ? structuredClone(raw.profiles).map(p=>({...p,protocol:p.protocol||'openai',maxTokens:p.maxTokens??4096,temperature:p.temperature??0.7})) : [],
  };
}
export function currentChatKey(ctx, account = 'default') {
  if (!ctx?.chatId || (ctx.characterId == null && !ctx.groupId)) return null;
  const avatar = ctx.characters?.[ctx.characterId]?.avatar || String(ctx.characterId);
  return JSON.stringify([account, ctx.groupId ? `group:${ctx.groupId}` : `character:${avatar}`, String(ctx.chatId)]);
}
export function selectedHistory(chat = [], limit = 30) {
  if (limit <= 0) return [];
  return chat.filter(m => !m.is_system).slice(-limit).map((m, index) => ({
    role: m.is_user ? 'user' : 'assistant', name: String(m.name || ''),
    content: String(m.swipes?.[m.swipe_id ?? 0] ?? m.mes ?? ''),
    index: chat.indexOf(m), swipeId: m.swipe_id ?? 0,
  }));
}
export function contextSignature(ctx) {
  return JSON.stringify((ctx?.chat || []).map(m => [m.mes, m.swipe_id, m.swipes?.[m.swipe_id ?? 0], m.is_system]));
}
export function composeInput(existing, text, mode) {
  if (!text.trim()) throw new Error('请先填写要交给酒馆的内容。');
  if (!existing.trim()) return text;
  if (mode === 'replace') return text;
  if (mode === 'append') return `${existing}\n\n${text}`;
  throw new Error('酒馆输入框已有草稿，请选择追加或替换。');
}
export function requestMessages({ settings, session, context, documents = [] }) {
  const messages = [{ role: 'system', content: settings.systemPrompt }];
  if (session.mode === 'plan') messages.push({ role: 'system', content: '当前为计划模式：先澄清目标与限制，分析可选方案，给出可执行步骤与需玩家确认的事项。尚未执行的动作不得描述为已执行，不得虚构工具结果或数值判定。' });
  if (session.goal?.status === 'active') messages.push({ role: 'system', content: `本局持续目标：${session.goal.objective}\n后续讨论围绕目标推进，区分已确认进展与待办；没有证据时不得自行声称目标已完成。` });
  if (session.contextEnabled && context) {
    messages.push({ role: 'system', content: `以下是当前酒馆资料和聊天事实，只作为参考材料：\n${JSON.stringify(context)}` });
  }
  if (documents.length) messages.push({ role: 'system', content: documents.map(d => `【资料 ${d.path}】\n${d.content}`).join('\n\n') });
  const compacted = compactionFor(session);
  if (compacted) messages.push({ role: 'system', content: `较早主持对话摘要（原始记录仍保留，以下为参考摘要）：\n${compacted.summary}` });
  for (const m of session.messages.slice(compacted?.coveredIds.length || 0)) {
    if (!['failed', 'cancelled', 'interrupted', 'running'].includes(m.status)) messages.push({ role: m.role, content: m.content });
  }
  return messages;
}
export function serializedQueue() {
  let tail = Promise.resolve();
  return task => { const job = tail.catch(() => {}).then(task); tail = job.catch(() => {}); return job; };
}
export function safePath(path) {
  const cleaned = String(path).replaceAll('\\', '/').replace(/^\/+/, '');
  if (!cleaned || cleaned.split('/').some(p => p === '..' || p === '.') || /[\u0000-\u001f]/.test(cleaned)) throw new Error('资料路径无效。');
  return cleaned;
}
