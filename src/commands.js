export const BUILTIN_COMMANDS = [
  {name:'reroll',description:'直接重新判定，不要求回退状态或正文'},
  { name: 'plan', description: '切换计划模式；可接要规划的任务' },
  { name: 'chat', description: '回到普通主持对话' },
  { name: 'goal', description: '设置目标；支持 status、pause、resume、done、clear' },
  { name: 'compact', description: '压缩较早对话，保留原始记录' },
  { name: 'status', description: '查看当前聊天、模型、上下文与目标' },
  { name: 'model', description: '打开模型与提示词设置' },
  { name: 'help', description: '查看可用指令' },
];
export function commandList(settings) {
  return [...BUILTIN_COMMANDS, ...(settings.customCommands || []).map(c => ({ ...c, custom: true, description: c.description || '自定义提示词指令' }))].filter(c => !(settings.disabledCommands || []).includes(c.name));
}
export function parseCommand(text) {
  if (!text.startsWith('/') || text.startsWith('//')) return null;
  const match = text.trim().match(/^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i);
  if (!match) throw new Error('指令格式无效，输入 /help 查看可用指令。');
  return { name: match[1].toLowerCase(), argument: match[2]?.trim() || '' };
}
export function validateCommands(commands) {
  const seen = new Set(BUILTIN_COMMANDS.map(c => c.name));
  return commands.map(command => {
    const name = command.name.trim().replace(/^\//, '').toLowerCase();
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) throw new Error('指令名请使用英文字母、数字、下划线或短横线，并以字母开头。');
    if (seen.has(name)) throw new Error(`/${name} 指令名重复。`);
    if (!command.template?.trim()) throw new Error(`请填写 /${name} 的提示词。`);
    seen.add(name); return { name, description: command.description?.trim() || '', template: command.template.trim() };
  });
}
export function expandCommand(command, argument) {
  return command.template.includes('{input}') ? command.template.replaceAll('{input}', argument) : `${command.template}${argument ? `\n\n${argument}` : ''}`;
}
export function updateGoal(session, argument) {
  const actions = { pause: 'paused', '暂停': 'paused', resume: 'active', '继续': 'active', done: 'complete', '完成': 'complete', clear: 'cleared', '清除': 'cleared' };
  if (actions[argument]) {
    if (!session.goal) throw new Error('本局还没有设置目标。');
    session.goal = { ...session.goal, status: actions[argument], updatedAt: Date.now() };
  } else {
    session.goal = { id: crypto.randomUUID(), objective: argument, status: 'active', createdAt: Date.now(), updatedAt: Date.now() };
  }
  session.goalHistory ??= []; session.goalHistory.push(structuredClone(session.goal));
  return session.goal;
}
