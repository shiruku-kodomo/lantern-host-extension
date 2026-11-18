import { NAMESPACE, currentChatKey, selectedHistory, composeInput } from './core.js';
export class TavernBridge {
  constructor(context = () => globalThis.SillyTavern?.getContext?.(), fetcher = globalThis.fetch.bind(globalThis)) {
    this.context = context; this.fetch = fetcher; this.account = 'default';
  }
  async init() {
    const ctx = this.context();
    if (!ctx?.getRequestHeaders || !ctx.extensionSettings) throw new Error('当前酒馆缺少扩展接口，请更新酒馆后重试。');
    const response = await this.fetch('/api/users/me', { headers: this.headers() });
    if (response.ok) this.account = (await response.json()).handle || 'default';
    else if (response.status !== 404) throw new Error('无法确认酒馆账号，请重新登录后刷新。');
    this.settingsBase = JSON.stringify(this.settings() ?? null);
  }
  key() { return currentChatKey(this.context(), this.account); }
  headers() { return this.context().getRequestHeaders(); }
  async http(path, payload) {
    const result = await this.fetch(path, { method: payload === undefined ? 'GET' : 'POST', headers: this.headers(), ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    if (!result.ok) throw new Error(`酒馆请求失败（${result.status}）`);
    return result.json();
  }
  settings() { return this.context().extensionSettings[NAMESPACE]; }
  async saveSettings(settings) {
    const before = await this.http('/api/settings/get', {});
    const latest = typeof before.settings === 'string' ? JSON.parse(before.settings) : before.settings;
    if (!latest || typeof latest !== 'object') throw new Error('酒馆设置读取失败，未覆盖现有配置。');
    const desired = JSON.stringify(settings), prior = JSON.stringify(latest.extension_settings?.[NAMESPACE] ?? null);
    if (prior !== (this.settingsBase ?? JSON.stringify(this.settings() ?? null)) && prior !== desired) throw new Error('主持配置已在其他窗口修改，请刷新后核对。当前输入仍保留。');
    latest.extension_settings ??= {};
    latest.extension_settings[NAMESPACE] = structuredClone(settings);
    // Merge only our namespace into the latest server settings, preserving unrelated changes.
    const written = await this.fetch('/api/settings/save', { method: 'POST', headers: this.headers(), body: JSON.stringify(latest) });
    if (!written.ok) throw new Error(`主持设置保存失败（${written.status}），输入已保留。`);
    const result = await this.http('/api/settings/get', {});
    const saved = typeof result.settings === 'string' ? JSON.parse(result.settings) : result.settings;
    if (JSON.stringify(saved?.extension_settings?.[NAMESPACE]) !== desired) throw new Error('酒馆没有确认设置保存，输入已保留，请重试。');
    this.context().extensionSettings[NAMESPACE] = structuredClone(settings);
    this.settingsBase = desired;
  }
  snapshot(limit) {
    const ctx = this.context();
    const card = ctx.characters?.[ctx.characterId];
    const data = card?.data || card || {};
    return {
      chatId: ctx.chatId, character: card?.name || '', player: ctx.name1 || '',
      persona: String(ctx.powerUserSettings?.persona_description || ''),
      description: String(data.description || ''), personality: String(data.personality || ''), scenario: String(data.scenario || ''),
      messages: selectedHistory(ctx.chat, limit),
    };
  }
  savedSession() { return this.context().chatMetadata?.[NAMESPACE]; }
  async readRemoteSession() {
    const ctx = this.context();
    const rows = ctx.groupId
      ? await this.http('/api/chats/group/get', { id: ctx.chatId })
      : await this.http('/api/chats/get', { avatar_url: ctx.characters[ctx.characterId].avatar, file_name: ctx.chatId });
    return rows?.[0]?.chat_metadata?.[NAMESPACE] ?? null;
  }
  async saveSession(key, session, base) {
    if (this.key() !== key) throw new Error('聊天已切换，记录已保留在原聊天的本地草稿中。');
    const prior = await this.readRemoteSession();
    if (JSON.stringify(prior) === JSON.stringify(session)) return;
    if (JSON.stringify(prior) !== base) throw new Error('这段聊天的主持记录已在其他窗口修改。当前内容已保留，请先导出，再刷新核对，避免覆盖。');
    if (this.key() !== key) throw new Error('聊天已切换，请回到原聊天重试同步。');
    const ctx = this.context();
    ctx.chatMetadata[NAMESPACE] = structuredClone(session);
    await ctx.saveChat();
    if (this.key() !== key) throw new Error('聊天已切换，请回到原聊天重试同步。');
    // Some versions swallow write failures. Read back the actual chat file.
    const stored = await this.readRemoteSession();
    if (JSON.stringify(stored) !== JSON.stringify(session)) throw new Error('酒馆存档尚未确认同步。草稿已保留，可重试保存。');
  }
  fill(text, mode) {
    const textarea = document.querySelector('#send_textarea');
    if (!textarea) throw new Error('未找到酒馆输入框，请先打开聊天。');
    textarea.value = composeInput(textarea.value, text, mode);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.focus();
  }
  on(name, fn) {
    const ctx = this.context(), type = ctx.eventTypes[name];
    if (!type) return () => {};
    ctx.eventSource.on(type, fn);
    return () => ctx.eventSource.removeListener(type, fn);
  }
}
