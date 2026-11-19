import { NAMESPACE, currentChatKey, selectedHistory, composeInput } from './core.js';
import { digest } from './game-db.js';
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
  hasChat() { return Boolean(currentChatKey(this.context(),this.account)); }
  key() { return currentChatKey(this.context(), this.account)||JSON.stringify([this.account,'host','independent']); }
  headers() { return this.context().getRequestHeaders(); }
  async http(path, payload) {
    const result = await this.fetch(path, { method: payload === undefined ? 'GET' : 'POST', headers: this.headers(), ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    if (!result.ok) throw Object.assign(new Error(`酒馆请求失败：${path}（${result.status}）`), {status:result.status,path});
    if(result.status===204)return null;
    return result.json();
  }
  settings() { return this.context().extensionSettings[NAMESPACE]; }
  async saveSettings(settings) {
    const before = await this.http('/api/settings/get', {});
    const latest = typeof before.settings === 'string' ? JSON.parse(before.settings) : before.settings;
    if (!latest || typeof latest !== 'object') throw new Error('酒馆设置读取失败，未覆盖现有配置。');
    if(latest.extension_settings?.[NAMESPACE]?.standaloneBinding)settings={...settings,standaloneBinding:latest.extension_settings[NAMESPACE].standaloneBinding};
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
      messages: this.hasChat()?selectedHistory(ctx.chat, limit):[],
    };
  }
  savedSession() { return this.hasChat()?this.context().chatMetadata?.[NAMESPACE]:this.settings()?.standaloneBinding; }
  async writeBackup(data) {
    const json = JSON.stringify(data), hash = await digest(json), name = `lantern-${data.branch.campaignId}-${data.branch.branchId}-${hash}.json`;
    if(json.length>512000){
      const chunks=[];for(let offset=0;offset<json.length;){let end=Math.min(offset+256000,json.length);if(end<json.length&&/[\uD800-\uDBFF]/.test(json[end-1]))end--;const chunk=json.slice(offset,end),sha256=await digest(chunk),path=await this.uploadText(`lantern-chunk-${sha256}.txt`,chunk);chunks.push({path,sha256});offset=end;}
      const manifest={format:'lantern-backup-index-v2',payloadHash:hash,chunks},text=JSON.stringify(manifest),sha256=await digest(text),path=await this.uploadText(name,text),pointer={path,sha256,bytes:new TextEncoder().encode(json).length,chunked:true};await this.readBackup(pointer);return pointer;
    }
    const path=await this.uploadText(name,json),pointer={path,sha256:hash,bytes:new TextEncoder().encode(json).length};await this.readBackup(pointer);return pointer;
  }
  async uploadText(name,json){
    const bytes = new TextEncoder().encode(json); let binary = '';
    for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));
    const uploaded = await this.http('/api/files/upload', { name, data: btoa(binary) });
    if(!uploaded.path)throw new Error('本局已保存，酒馆未返回备份路径。');
    return uploaded.path;
  }
  async backupText(pointer) {
    const url = new URL(pointer.path, globalThis.location?.href || 'http://localhost/');
    if(globalThis.location&&url.origin!==location.origin)throw new Error('备份路径不属于当前酒馆。');
    const response=await this.fetch(url,{headers:this.headers(),cache:'no-store'});
    if(!response.ok)throw new Error('本局已保存，备份读取失败，可重试同步。');
    const text=await response.text();if(await digest(text)!==pointer.sha256)throw new Error('备份核对失败，未标记同步完成。');
    return text;
  }
  async readBackup(pointer) {
    let text=await this.backupText(pointer),data=JSON.parse(text);
    if(data.format==='lantern-backup-index-v2'){
      const pieces=[];for(const chunk of data.chunks)pieces.push(await this.backupText(chunk));text=pieces.join('');if(await digest(text)!==data.payloadHash)throw new Error('分块备份整体校验失败。');data=JSON.parse(text);
    }
    if(data.format!=='lantern-backup-v2')throw new Error('不支持的备份格式。');return data;
  }
  async worldModule() { return import('/scripts/world-info.js'); }
  async worldNames() { const data=await this.http('/api/settings/get',{});if(!Array.isArray(data.world_names))throw new Error('酒馆未返回世界书文件列表（/api/settings/get）。');return data.world_names; }
  async extensionType(name) { const mod=await import('/scripts/extensions.js');return mod.extensionTypes?.[`third-party/${name}`]||mod.extensionTypes?.[name]||null; }
  async saveWorld(name,data) {
    await this.http('/api/worldinfo/edit',{name,data});
    const read=await this.http('/api/worldinfo/get',{name});
    if(await digest(read)!==await digest(data))throw new Error('情报世界书写入后核对失败。');
    const mod=await this.worldModule();mod.worldInfoCache?.delete(name);await mod.updateWorldInfoList();
    await mod.loadWorldInfo(name);return read;
  }
  async bindWorld(key,name) {
    if(key!==this.key())throw new Error('聊天已经切换，世界书绑定留待原局重试。');
    this.context().chatMetadata.world_info=name;await this.context().saveChat();
    const ctx=this.context(),rows=ctx.groupId?await this.http('/api/chats/group/get',{id:ctx.chatId}):await this.http('/api/chats/get',{avatar_url:ctx.characters[ctx.characterId].avatar,file_name:ctx.chatId});
    if(rows?.[0]?.chat_metadata?.world_info!==name)throw new Error('世界书绑定未确认保存。');
  }
  async readRemoteSession() {
    if(!this.hasChat()){const data=await this.http('/api/settings/get',{}),settings=typeof data.settings==='string'?JSON.parse(data.settings):data.settings;return settings?.extension_settings?.[NAMESPACE]?.standaloneBinding??null;}
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
    if(!this.hasChat()){
      const data=await this.http('/api/settings/get',{}),latest=typeof data.settings==='string'?JSON.parse(data.settings):data.settings;
      latest.extension_settings??={};const own={...(latest.extension_settings[NAMESPACE]||{}),standaloneBinding:structuredClone(session)};latest.extension_settings[NAMESPACE]=own;
      await this.http('/api/settings/save',latest);if(JSON.stringify(await this.readRemoteSession())!==JSON.stringify(session))throw new Error('独立主持备份索引尚未确认同步。');
      this.context().extensionSettings[NAMESPACE]=own;this.settingsBase=JSON.stringify(own);return;
    }
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
