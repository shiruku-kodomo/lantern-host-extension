import { requestMessages } from './core.js';
import { compactionFor } from './conversation.js';

// Conservative byte-based estimate, never presented as a tokenizer's exact count.
export function estimateTokens(messages) {
  const encoder = new TextEncoder();
  return messages.reduce((total, m) => total + 8 + Math.ceil(encoder.encode(m.content || '').length / 2), 0) + 8;
}
export function contextBudget(profile) {
  const capacity = Number(profile?.contextWindow) || 128000;
  const reserve = Math.max(256, Math.ceil(capacity * 0.01));
  return { capacity, inputLimit: capacity - (Number(profile?.maxTokens) || 4096) - reserve };
}
export class ContextManager {
  constructor(model) { this.model = model; }
  async prepare(input, profile, { signal, force = false, onCompacting } = {}) {
    const budget = contextBudget(profile);
    if (budget.inputLimit < 512) throw new Error('最大回复 Token 占用了上下文容量，请降低回复上限或提高模型上下文容量。');
    let messages = requestMessages(input), used = estimateTokens(messages);
    if (!force && (input.settings.autoCompact === false || used < budget.inputLimit * 0.8)) {
      if (used > budget.inputLimit) throw new Error('预计上下文超出模型容量，请开启自动压缩或减少附加资料。');
      return { messages, used, ...budget };
    }
    const session = input.session, history = session.messages.filter(m => m.status !== 'running');
    const previous = compactionFor(session);
    let split = Math.max(0, history.length - 6);
    // Preserve the most recent turns. Expand the summarized prefix if the retained tail is large.
    const fixed = requestMessages({ ...input, session: { ...session, messages: [], compactions: [] } });
    while (split < history.length - 3 && estimateTokens([...fixed, ...history.slice(split)]) > budget.inputLimit * 0.65) split++;
    while (split > 0 && history[split - 1]?.role !== 'assistant') split--;
    if (split < 2 || (previous && split <= previous.coveredIds.length)) {
      if (used > budget.inputLimit || force) throw new Error('可压缩的较早对话不足。请减少本轮输入或附加资料，或提高模型上下文容量。');
      return { messages, used, ...budget };
    }
    onCompacting?.(); signal?.throwIfAborted();
    const older = history.slice(previous?.coveredIds.length || 0, split).filter(m => !['failed','cancelled','interrupted','running'].includes(m.status));
    const summaryInput = [
      { role: 'system', content: '请压缩主持对话，供后续主持继续工作。只输出摘要。必须保留玩家意图、确定事实、人物立场与知情边界、地点时间、物品、所有明确数值及其来源、已确认决定、未决事项；区分建议与已发生事实。保留专名和资料路径。不推断、不重新计算数值、不虚构判定或工具结果。资料原文仍可查阅。新信息与旧摘要冲突时明确标记，不擅自消解。' },
      { role: 'user', content: JSON.stringify({ previousSummary: previous?.summary || '', earlierMessages: older.map(m => ({ role: m.role, content: m.content })) }) },
    ];
    const summary = await this.model.chat({ ...profile, maxTokens: Math.min(4096, Math.max(512, Math.floor(budget.capacity / 32))), temperature: 0.2 }, summaryInput, { signal });
    signal?.throwIfAborted();
    const compaction = { id: crypto.randomUUID(), createdAt: Date.now(), coveredIds: history.slice(0, split).map(m => m.id), summary, estimatedBefore: used };
    const packed = { ...session, compactions: [...(session.compactions || []), compaction] };
    messages = requestMessages({ ...input, session: packed }); used = estimateTokens(messages);
    compaction.estimatedAfter = used;
    if (used >= compaction.estimatedBefore) throw new Error('摘要没有有效缩短上下文，已保留原始记录。请减少附加资料或提高上下文容量。');
    if (used > budget.inputLimit) throw new Error('压缩后本轮输入和附加资料仍超出容量，请减少资料或提高模型上下文容量。原始记录保留。');
    return { messages, compaction, used, ...budget };
  }
}
