import { TavernBridge } from './src/bridge.js';
import { LocalStore } from './src/storage.js';
import { ModelClient, connectionPayload } from './src/provider.js';
import { SessionRepository } from './src/sessions.js';
import { hydrateConversation, appendMessage, editUserMessage, versionsOf, switchVersion } from './src/conversation.js';
import { ContextManager, contextBudget, estimateTokens } from './src/context.js';
import { BUILTIN_COMMANDS, commandList, parseCommand, expandCommand, updateGoal, validateCommands } from './src/commands.js';
import { renderMarkdown } from './src/markdown.js';
import { DocumentLibrary } from './src/documents.js';
import { normalizeSettings, emptySession, requestMessages, contextSignature } from './src/core.js';

const ROOT_ID = 'lantern-host-root';
const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const icon = name => ({ close: '×', minimize: '−', expand: '⛶', chat: '◌', files: '▤', model: '⚙', send: '↑', back: '‹' }[name] || name);
let application;
let initializing;

class HostWorkspace {
  constructor(bridge, storage) {
    this.bridge = bridge; this.storage = storage; this.model = new ModelClient(bridge);
    this.sessions = new SessionRepository(bridge, storage); this.profileDrafts = new Map();
    this.contextManager = new ContextManager(this.model);
    this.settings = normalizeSettings(bridge.settings()); this.session = emptySession(); this.key = null;
    this.tab = 'chat'; this.error = ''; this.saveError = ''; this.syncing = false;
    this.cleanups = []; this.generation = 0; this.loadGeneration = 0; this.busy = false;
    this.models = []; this.profileDraft = null; this.promptDraft = this.settings.systemPrompt; this.settingsDirty = false;
    this.commandDrafts = structuredClone(this.settings.customCommands); this.disabledCommandDrafts = new Set(this.settings.disabledCommands);
  }
  async init() {
    this.buildShell();
    this.syncAppearance();
    this.cleanups.push(this.bridge.on('SETTINGS_UPDATED', () => this.syncAppearance()));
    this.cleanups.push(this.bridge.on('CHAT_CHANGED', () => this.changeChat()));
    for (const event of ['MESSAGE_SWIPED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_RECEIVED', 'MESSAGE_SENT']) {
      this.cleanups.push(this.bridge.on(event, () => {
        if (this.busy && contextSignature(this.bridge.context()) !== this.runningContext) this.stop('酒馆上下文已变化，本次生成已停止，请核对后重试。');
        this.renderContextBadge();
      }));
    }
    const viewport = () => {
      const vv = window.visualViewport;
      this.root.style.setProperty('--lh-height', `${vv?.height || innerHeight}px`);
      this.root.style.setProperty('--lh-top', `${vv?.offsetTop || 0}px`);
    };
    viewport();
    window.visualViewport?.addEventListener('resize', viewport);
    window.visualViewport?.addEventListener('scroll', viewport);
    this.cleanups.push(() => { window.visualViewport?.removeEventListener('resize', viewport); window.visualViewport?.removeEventListener('scroll', viewport); });
    const unload = event => { if (this.saveError || this.settingsDirty || this.syncing || this.draftTimer) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', unload); this.cleanups.push(() => window.removeEventListener('beforeunload', unload));
    await this.changeChat();
    this.library = new DocumentLibrary(this.storage);
    try { await this.library.init(); } catch (error) { this.libraryError = error.message; }
    this.render();
  }
  buildShell() {
    this.root = document.createElement('div'); this.root.id = ROOT_ID;
    this.root.innerHTML = `<button class="lh-launcher" hidden aria-label="恢复主持窗口">灯</button>
      <dialog class="lh-backdrop" aria-label="灯火之外主持" hidden><section class="lh-panel" tabindex="-1">
      <header class="lh-header"><div class="lh-brand"><span class="lh-mark">灯</span><div><strong>灯火之外</strong><small>主持</small></div></div><span class="lh-chat-name"></span><div class="lh-window-actions">
      <button data-window="minimize" title="收起" aria-label="收起主持">${icon('minimize')}</button><button data-window="expand" title="全屏" aria-label="切换全屏">${icon('expand')}</button><button data-window="close" title="关闭" aria-label="关闭主持">${icon('close')}</button></div></header>
      <nav class="lh-nav" aria-label="主持工作区"><button data-tab="chat">${icon('chat')} 对话</button><button data-tab="documents">${icon('files')} 资料</button><button data-tab="settings">${icon('model')} 模型与提示词</button></nav>
      <div class="lh-alert" role="alert" hidden></div><main class="lh-main"></main><footer class="lh-footer"><span class="lh-save-status" role="status"></span><button data-action="retry-save" hidden>重试保存</button><button data-action="export">导出本局</button></footer>
      </section></dialog>`;
    // A body backdrop-filter/transform creates a containing block for fixed children.
    // Portal beside body so mobile scroll and keyboard panning cannot displace the workspace.
    document.documentElement.append(this.root);
    this.root.querySelector('.lh-launcher').onclick = () => this.open();
    this.root.querySelector('.lh-backdrop').addEventListener('cancel', event => { event.preventDefault(); this.close(); });
    this.root.addEventListener('click', event => {
      const button = event.target.closest('button');
      if (!button) return;
      if (button.dataset.window === 'close') return this.close();
      if (button.dataset.window === 'minimize') return this.close(true);
      if (button.dataset.window === 'expand') return this.root.querySelector('.lh-panel').classList.toggle('lh-fullscreen');
      if (button.dataset.tab) { this.tab = button.dataset.tab; this.error = ''; this.render(); return; }
      this.action(button.dataset.action, button).catch(error => { this.error = this.redact(error.message); this.renderAlert(); });
    });
    this.root.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); this.close(); }
      if (event.key === 'Tab') {
        const controls = [...this.root.querySelectorAll('.lh-panel button, .lh-panel input, .lh-panel textarea, .lh-panel select')].filter(el => !el.disabled && el.getClientRects().length);
        if (!controls.length) return;
        if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1).focus(); }
        else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0].focus(); }
      }
    });
    this.settingsEntry = document.createElement('div'); this.settingsEntry.className = 'lantern-host-settings-entry';
    this.settingsEntry.innerHTML = '<strong>灯火之外 · 主持</strong><button class="menu_button">打开主持</button>';
    this.settingsEntry.querySelector('button').onclick = () => this.open();
    (document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings') || document.body).append(this.settingsEntry);
    this.quickEntry = document.createElement('button'); this.quickEntry.className = 'list-group-item flex-container flexGap5';
    this.quickEntry.textContent = '灯火之外 · 主持'; this.quickEntry.onclick = () => this.open();
    document.querySelector('#extensionsMenu')?.append(this.quickEntry);
  }
  syncAppearance() {
    const body = getComputedStyle(document.body);
    const value = body.getPropertyValue('--SmartThemeBlurTintColor').trim() || '#242321';
    for (const [target, source, fallback] of [['--lh-bg','--SmartThemeBlurTintColor','#242321'],['--lh-panel','--SmartThemeChatTintColor','#2b2926'],['--lh-text','--SmartThemeBodyColor',body.color],['--lh-accent','--SmartThemeQuoteColor','#d6b27d']]) this.root.style.setProperty(target, body.getPropertyValue(source).trim() || fallback);
    const probe = document.createElement('span'); probe.hidden = true; probe.style.color = value; this.root.append(probe);
    const channels = getComputedStyle(probe).color.match(/[\d.]+/g); probe.remove();
    this.root.style.setProperty('--lh-solid-bg', channels?.length >= 3 ? `rgb(${channels.slice(0,3).join(',')})` : '#242321');
  }
  open() {
    this.previousFocus = document.activeElement;
    const dialog = this.root.querySelector('.lh-backdrop'); dialog.hidden = false;
    if (!dialog.open) dialog.showModal();
    this.root.querySelector('.lh-launcher').hidden = true;
    this.render(); this.root.querySelector('.lh-panel').focus();
  }
  close(minimize = false) {
    if (!minimize) this.stop();
    const dialog = this.root.querySelector('.lh-backdrop'); if (dialog.open) dialog.close(); dialog.hidden = true;
    this.root.querySelector('.lh-launcher').hidden = !minimize;
    this.previousFocus?.focus?.();
    if (this.key) this.persist().catch(error => { this.saveError = error.message; });
  }
  redact(message) {
    let result = String(message || '操作失败，请重试。');
    for (const p of [...this.settings.profiles, this.profileDraft].filter(Boolean)) {
      if (p.apiKey) result = result.replaceAll(p.apiKey, '[密钥已隐藏]');
    }
    return result;
  }
  async changeChat() {
    this.stop();
    clearTimeout(this.draftTimer);
    this.draftTimer = null;
    const generation = ++this.loadGeneration;
    const key = this.bridge.key();
    this.root.querySelector('.lh-modal')?.remove();
    this.key = key; this.error = ''; this.saveError = ''; this.loadFailed = false; this.loading = true; this.session = emptySession(); this.render();
    if (!key) { this.session = emptySession(); this.loading = false; this.render(); return; }
    try {
      const { session, dirty } = await this.sessions.load(key);
      if (generation !== this.loadGeneration) return;
      this.session = session;
      if (dirty) this.saveError = '本地有未同步内容，可重试保存到酒馆存档。';
      if (this.session.pending) {
        for (const m of this.session.messages) if (m.status === 'running') m.status = 'interrupted';
        this.session.pending = null; this.error = '上次回复未完成，已保留输入和收到的内容，可以重试。';
      }
    } catch (error) { this.error = error.message; this.loadFailed = true; }
    finally { if (generation === this.loadGeneration) { this.loading = false; this.render(); } }
  }
  async persist() {
    if (!this.key || this.loading || this.loadFailed) return;
    const key = this.key, snapshot = structuredClone(this.session);
    snapshot.revision = ++this.session.revision; snapshot.updatedAt = Date.now(); this.session.updatedAt = snapshot.updatedAt;
    this.syncCount = (this.syncCount || 0) + 1; this.syncing = true; this.renderStatus();
    return (async () => {
      try {
        const confirmed = await this.sessions.sync(key, snapshot);
        if (this.key === key && confirmed) this.saveError = '';
      } catch (error) { if (this.key === key) this.saveError = this.redact(error.message); throw error; }
      finally { this.syncCount--; this.syncing = this.syncCount > 0; this.renderStatus(); }
    })();
  }
  saveSoon() {
    clearTimeout(this.draftTimer);
    // Local durability does not depend on a successful server connection.
    this.cache();
    this.draftTimer = setTimeout(() => { this.draftTimer = null; this.persist().catch(() => {}); }, 600);
    this.renderStatus();
  }
  cache() {
    if (!this.key) return;
    const key = this.key;
    this.session.updatedAt = Date.now();
    this.sessions.cache(key, this.session).catch(error => { if (key === this.key) { this.saveError = error.message; this.renderStatus(); } });
  }
  renderStatus() {
    const node = this.root.querySelector('.lh-save-status');
    node.textContent = this.saveError || (this.syncing || this.draftTimer ? '保存中…' : this.key ? '已保存' : '先在酒馆打开一段聊天');
    node.classList.toggle('lh-error-text', Boolean(this.saveError));
    this.root.querySelector('[data-action="retry-save"]').hidden = !this.saveError;
  }
  renderAlert() {
    const node = this.root.querySelector('.lh-alert'); node.hidden = !this.error;
    node.textContent = this.error;
  }
  render() {
    if (!this.root) return;
    for (const button of this.root.querySelectorAll('[data-tab]')) button.setAttribute('aria-current', button.dataset.tab === this.tab ? 'page' : 'false');
    const snapshot = this.bridge.snapshot(0);
    this.root.querySelector('.lh-chat-name').textContent = snapshot.character || '尚未打开聊天';
    if (this.tab === 'settings') this.renderSettings();
    else if (this.tab === 'documents') this.renderDocuments().catch(error => { this.error = this.redact(error.message); this.renderAlert(); });
    else this.renderChat();
    this.renderAlert(); this.renderStatus();
  }
  profile() { return this.settings.profiles.find(p => p.id === this.settings.activeProfileId); }
  renderChat() {
    const main = this.root.querySelector('.lh-main');
    main.innerHTML = `<section class="lh-chat"><div class="lh-context-line"><label><input type="checkbox" id="lh-context-toggle" ${this.session.contextEnabled ? 'checked' : ''}>带入酒馆上下文</label><button data-action="context" class="lh-context-count"></button><span class="lh-model-label">${escape(this.profile()?.model || '未连接模型')}</span></div>
      <div class="lh-budget-line"><span class="lh-budget" role="status"></span><button data-action="compact" ${this.busy || !this.key ? 'disabled' : ''}>压缩较早对话</button></div><div class="lh-messages" role="log" aria-label="主持对话"></div>
      <div class="lh-selected-docs"></div><div class="lh-session-mode"></div><form class="lh-composer"><div class="lh-command-menu" role="listbox" aria-label="主持指令" hidden></div><textarea id="lh-input" rows="2" aria-label="给主持的消息" placeholder="和主持讨论这一轮，或输入 / 使用指令…" ${!this.key || this.loading || this.loadFailed ? 'disabled' : ''}>${escape(this.session.draft)}</textarea><button class="lh-primary" type="submit" ${!this.key || this.loading || this.loadFailed ? 'disabled' : ''}>${this.busy ? '停止' : '发送'}</button></form></section>`;
    const log = main.querySelector('.lh-messages');
    if (!this.session.messages.length) log.innerHTML = `<div class="lh-empty"><span class="lh-empty-mark">灯</span><h2>${this.loading ? '正在读取记录…' : this.key ? '开始这局的讨论' : '先打开酒馆聊天'}</h2><p>${this.key ? '主持对话会随当前聊天保存。' : '选择角色和聊天后，在这里继续。'}</p>${!this.profile() ? '<button data-tab="settings" class="lh-primary">连接主持模型</button>' : ''}</div>`;
    for (const message of this.session.messages) {
      const row = document.createElement('article'); row.className = `lh-message lh-${message.role}`; row.dataset.messageId = message.id;
      row.innerHTML = `<header><strong>${message.role === 'user' ? '你' : '主持'}</strong><span>${escape({ running: this.runPhase === 'compacting' ? '正在压缩上下文…' : '回复中', cancelled: '已停止', failed: '未完成', interrupted: '已中断' }[message.status] || '')}</span></header><div class="lh-message-text"></div><div class="lh-message-actions"></div>`;
      if (message.role === 'assistant') this.markdown(row.querySelector('.lh-message-text'), message.content);
      else row.querySelector('.lh-message-text').textContent = message.content;
      const actions = row.querySelector('.lh-message-actions');
      if (message.role === 'user') actions.innerHTML = `<button data-action="edit-message" data-id="${escape(message.id)}" title="编辑消息" aria-label="编辑消息" ${this.busy ? 'disabled' : ''}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 14Z"/></svg></button>`;
      else if (message.status !== 'running') actions.innerHTML = `${message.content ? `<button data-action="preview" data-id="${escape(message.id)}">交给酒馆</button>` : ''}<button data-action="retry" data-id="${escape(message.id)}" ${this.busy ? 'disabled' : ''}>重试这次回复</button>`;
      if (message.error) { const error = document.createElement('p'); error.className = 'lh-message-error'; error.textContent = message.error; row.querySelector('.lh-message-text').after(error); }
      const versions = versionsOf(this.session, message.id);
      if (versions.total > 1) actions.insertAdjacentHTML('beforeend', `<span class="lh-versions"><button data-action="version-prev" data-id="${escape(message.id)}" aria-label="上一个消息版本" ${this.busy || versions.index === 0 ? 'disabled' : ''}>‹</button><span>${versions.index + 1} / ${versions.total}</span><button data-action="version-next" data-id="${escape(message.id)}" aria-label="下一个消息版本" ${this.busy || versions.index === versions.total - 1 ? 'disabled' : ''}>›</button></span>`);
      if (message.role === 'user' && this.session.editDraft?.messageId === message.id) {
        row.classList.add('lh-editing');
        const body = row.querySelector('.lh-message-text');
        body.innerHTML = '<form class="lh-inline-editor"><textarea aria-label="编辑这条消息" rows="3"></textarea><div class="lh-buttons"><button type="button" data-action="edit-cancel">取消</button><button type="submit" class="lh-primary">发送</button></div></form>';
        const input = body.querySelector('textarea'); input.value = this.session.editDraft.text;
        input.oninput = () => { this.session.editDraft.text = input.value; this.saveSoon(); };
        body.querySelector('form').onsubmit = event => { event.preventDefault(); this.send({ editId: message.id, text: input.value }).catch(error => { this.error = this.redact(error.message); this.renderAlert(); }); };
        input.onkeydown = event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); body.querySelector('form').requestSubmit(); } };
        actions.hidden = true;
      }
      log.append(row);
    }
    if (this.session.messages.length) log.scrollTop = log.scrollHeight;
    const selected = main.querySelector('.lh-selected-docs');
    selected.textContent = this.session.selectedDocs.length ? `已附加 ${this.session.selectedDocs.length} 份资料` : '';
    if (this.session.handoff) { const resume = document.createElement('button'); resume.dataset.action = 'preview-draft'; resume.textContent = '继续编辑交接草稿'; selected.append(resume); }
    main.querySelector('#lh-context-toggle').onchange = event => { this.session.contextEnabled = event.target.checked; this.saveSoon(); };
    main.querySelector('#lh-input').oninput = event => { this.session.draft = event.target.value; this.commandIndex = 0; this.saveSoon(); this.renderBudget(); this.renderCommandMenu(); };
    main.querySelector('.lh-composer').onsubmit = event => { event.preventDefault(); if (this.busy) this.stop(); else this.submit().catch(error => { this.error = this.redact(error.message); this.renderAlert(); }); };
    main.querySelector('#lh-input').onkeydown = event => {
      const menu = main.querySelector('.lh-command-menu');
      if (!menu.hidden && ['ArrowDown','ArrowUp','Enter','Tab','Escape'].includes(event.key) && !event.ctrlKey && !event.metaKey) {
        event.preventDefault(); event.stopPropagation();
        const items = [...menu.querySelectorAll('button')];
        if (event.key === 'Escape') { menu.hidden = true; return; }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { this.commandIndex = ((this.commandIndex || 0) + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; this.renderCommandMenu(); }
        else items[this.commandIndex || 0]?.click(); return;
      }
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); main.querySelector('.lh-composer').requestSubmit(); }
    };
    main.querySelector('.lh-session-mode').textContent = `${this.session.mode === 'plan' ? '计划模式' : ''}${this.session.goal && this.session.goal.status !== 'cleared' ? `${this.session.mode === 'plan' ? ' · ' : ''}目标：${this.session.goal.objective}（${{ active:'进行中', paused:'已暂停', complete:'已完成' }[this.session.goal.status] || this.session.goal.status}）` : ''}`;
    this.renderContextBadge();
    this.renderBudget();
  }
  markdown(element, text, path) { renderMarkdown(element, text, { library: this.library, path, openDocument: id => { this.tab = 'documents'; this.selectedDoc = id; this.render(); } }); }
  renderCommandMenu() {
    const menu = this.root.querySelector('.lh-command-menu'); if (!menu) return;
    const query = this.session.draft.match(/^\/([a-z0-9_-]*)$/i)?.[1];
    const items = query === undefined ? [] : commandList(this.settings).filter(c => c.name.startsWith(query.toLowerCase()));
    menu.hidden = !items.length;
    menu.innerHTML = items.map((item, index) => `<button type="button" role="option" aria-selected="${index === (this.commandIndex || 0)}" data-action="command-insert" data-name="${escape(item.name)}"><strong>/${escape(item.name)}</strong><span>${escape(item.description)}</span></button>`).join('');
  }
  async submit() {
    const text = this.session.draft.trim(), command = parseCommand(text);
    if (!command) return this.send();
    const item = commandList(this.settings).find(c => c.name === command.name);
    if (!item) throw new Error('指令未启用或不存在，请输入 /help 查看。');
    if (item.custom) { this.session.draft = expandCommand(item, command.argument); this.saveSoon(); return this.send(); }
    if (command.name === 'plan') { this.session.mode = command.argument === 'off' ? 'chat' : 'plan'; this.session.draft = command.argument === 'off' ? '' : command.argument; this.saveSoon(); this.render(); if (this.session.draft) return this.send(); return; }
    if (command.name === 'chat') { this.session.mode = 'chat'; this.session.draft = command.argument; this.saveSoon(); this.render(); if (command.argument) return this.send(); return; }
    if (command.name === 'goal') {
      if (!command.argument || command.argument === 'status') { this.showPreview(this.session.goal ? `目标：${this.session.goal.objective}\n状态：${{active:'进行中',paused:'已暂停',complete:'已完成',cleared:'已清除'}[this.session.goal.status] || this.session.goal.status}` : '本局尚未设置目标。', true); this.root.querySelector('.lh-modal h2').textContent = '本局目标'; return; }
      updateGoal(this.session, command.argument); this.session.draft = ''; this.saveSoon(); this.render(); return;
    }
    this.session.draft = ''; this.saveSoon();
    if (command.name === 'compact') return this.compactNow();
    if (command.name === 'model') { this.tab = 'settings'; this.render(); return; }
    if (command.name === 'help') { this.showPreview(commandList(this.settings).map(c => `/${c.name}  ${c.description}`).join('\n'), true); this.root.querySelector('.lh-modal h2').textContent = '主持指令'; return; }
    if (command.name === 'status') { this.showPreview(`聊天：${this.bridge.snapshot(0).character || '未选择'}\n模型：${this.profile()?.model || '未设置'}\n模式：${this.session.mode === 'plan' ? '计划' : '对话'}\n目标：${this.session.goal?.objective || '未设置'}\n压缩记录：${this.session.compactions.length} 次\n${this.root.querySelector('.lh-budget')?.title || ''}`, true); this.root.querySelector('.lh-modal h2').textContent = '本局状态'; }
  }
  renderBudget() {
    const node = this.root.querySelector('.lh-budget'); if (!node) return;
    const profile = this.profile(); if (!profile) { node.textContent = ''; return; }
    const budget = contextBudget(profile);
    const catalog = this.library?.catalog ? this.library.list() : [];
    const docBytes = this.session.selectedDocs.map(id => catalog.find(d => d.id === id)).filter(Boolean).reduce((n, d) => n + (d.bytes || new TextEncoder().encode(d.content || '').length), 0);
    const used = estimateTokens(requestMessages({ settings: this.settings, session: this.session, context: this.bridge.snapshot(this.settings.contextLimit) })) + Math.ceil(docBytes / 2) + estimateTokens([{ content: this.session.draft }]);
    const total = used + (Number(profile.maxTokens) || 4096);
    node.textContent = this.runPhase === 'compacting' && this.busy ? '正在压缩较早对话…' : `上下文估算 ${Math.min(100, Math.round(total / budget.capacity * 100))}% · ${Math.round(used / 1000)}k / ${Math.round(budget.capacity / 1000)}k${this.session.compactions?.length ? ' · 已压缩' : ''}`;
    node.title = `输入估算 ${used} Token，预留回复 ${Number(profile.maxTokens) || 4096} Token；容量 ${budget.capacity}。${this.settings.autoCompact ? '接近容量时自动压缩。' : '自动压缩已关闭。'}`;
  }
  renderContextBadge() {
    const node = this.root.querySelector('.lh-context-count');
    if (node) node.textContent = `查看 ${this.bridge.snapshot(this.settings.contextLimit).messages.length} 条消息`;
  }
  async send(options = {}) {
    if (this.busy || !this.key || this.loadFailed) return;
    const { retryId, editId, text: editedText } = options;
    const profile = structuredClone(this.profile());
    if (!profile) { this.tab = 'settings'; this.render(); throw new Error('请先保存并选择主持模型。'); }
    hydrateConversation(this.session);
    let replyParent;
    if (retryId) {
      const previous = this.session.messages.find(m => m.id === retryId && m.role === 'assistant');
      if (!previous) throw new Error('未找到要重试的回复。');
      replyParent = previous.parentId;
    } else if (editId) {
      editUserMessage(this.session, editId, editedText);
      this.session.editDraft = null;
    } else {
      const text = this.session.draft.trim(); if (!text) return;
      appendMessage(this.session, { id: crypto.randomUUID(), role: 'user', content: text, status: 'complete' }); this.session.draft = '';
    }
    const assistant = appendMessage(this.session, { id: crypto.randomUUID(), role: 'assistant', content: '', status: 'running' }, replyParent);
    this.busy = true; this.error = ''; this.controller = new AbortController();
    const controller = this.controller, key = this.key, generation = ++this.generation;
    this.runningContext = contextSignature(this.bridge.context());
    this.session.pending = { messageId: assistant.id, startedAt: Date.now(), profileId: profile.id };
    const requestSession = structuredClone(this.session);
    const requestSettings = structuredClone(this.settings), requestContext = this.bridge.snapshot(this.settings.contextLimit);
    this.render();
    let lastCheckpoint = 0;
    try {
      await this.persist();
      const documents = await Promise.all(requestSession.selectedDocs.map(id => this.library.read(id)));
      if (documents.reduce((size, doc) => size + doc.content.length, 0) > 100000) throw new Error('附加资料超过 10 万字，请减少所选资料后重试。');
      controller.signal.throwIfAborted();
      this.runPhase = 'generating';
      const prepared = await this.contextManager.prepare({ settings: requestSettings, session: requestSession, context: requestContext, documents }, profile, {
        signal: controller.signal, onCompacting: () => { this.runPhase = 'compacting'; this.session.pending.stage = 'compacting'; this.render(); },
      });
      controller.signal.throwIfAborted();
      if (generation !== this.generation || this.key !== key) return;
      if (prepared.compaction) { this.session.compactions.push(prepared.compaction); await this.persist(); }
      controller.signal.throwIfAborted();
      this.runPhase = 'generating'; this.session.pending.stage = 'generating'; this.render();
      const content = await this.model.chat(structuredClone(profile), prepared.messages, {
        signal: controller.signal,
        onText: text => {
          if (generation !== this.generation || this.key !== key) return;
          assistant.content = text;
          const node = this.root.querySelector(`[data-message-id="${assistant.id}"] .lh-message-text`);
          if (node) { this.markdown(node, text); const log = node.closest('.lh-messages'); if (log.scrollHeight - log.scrollTop - log.clientHeight < 180) log.scrollTop = log.scrollHeight; }
          if (Date.now() - lastCheckpoint > 1000) { lastCheckpoint = Date.now(); this.cache(); }
        },
      });
      if (generation !== this.generation || this.key !== key) return;
      assistant.content = content; assistant.status = 'complete';
    } catch (error) {
      if (generation !== this.generation || this.key !== key) return;
      if (error.partial) assistant.content = error.partial;
      assistant.status = controller.signal.aborted ? 'cancelled' : 'failed';
      this.error = controller.signal.aborted ? '已停止，收到的内容已保留。' : this.redact(error.message);
      assistant.error = this.error;
    } finally {
      if (generation === this.generation && this.key === key) {
        this.busy = false; this.controller = null; this.runPhase = ''; this.session.pending = null;
        await this.persist().catch(() => {}); this.render();
      }
    }
  }
  stop(reason) {
    if (!this.busy) return;
    this.controller?.abort(); this.busy = false;
    const last = this.session.messages.at(-1); if (last?.status === 'running') last.status = 'cancelled';
    this.session.pending = null;
    this.cache();
    if (reason) this.error = reason;
    this.render();
  }
  async compactNow() {
    if (this.busy || !this.key || this.loadFailed) return;
    const profile = structuredClone(this.profile()); if (!profile) throw new Error('请先保存主持模型。');
    this.busy = true; this.runPhase = 'compacting'; this.error = '';
    const controller = this.controller = new AbortController(), key = this.key, generation = ++this.generation;
    this.session.pending = { kind: 'compaction', startedAt: Date.now() }; this.render();
    try {
      await this.persist();
      const input = { settings: structuredClone(this.settings), session: structuredClone(this.session), context: this.bridge.snapshot(this.settings.contextLimit), documents: await Promise.all(this.session.selectedDocs.map(id => this.library.read(id))) };
      const result = await this.contextManager.prepare(input, profile, { signal: controller.signal, force: true });
      controller.signal.throwIfAborted();
      if (key !== this.key || generation !== this.generation) return;
      if (result.compaction) this.session.compactions.push(result.compaction);
      this.error = '已压缩较早对话，原始消息和版本仍保留。';
    } catch (error) { if (key === this.key && generation === this.generation) this.error = controller.signal.aborted ? '压缩已停止，原始记录保留。' : this.redact(error.message); }
    finally { if (key === this.key && generation === this.generation) { this.busy = false; this.runPhase = ''; this.controller = null; this.session.pending = null; await this.persist().catch(() => {}); this.render(); } }
  }
  renderSettings() {
    const main = this.root.querySelector('.lh-main');
    if (!this.profileDraft) this.profileDraft = structuredClone(this.profile() || { id: crypto.randomUUID(), name: '主持模型', protocol: 'openai', baseUrl: '', apiKey: '', model: '', maxTokens: 4096, temperature: 0.7 });
    const p = this.profileDraft;
    main.innerHTML = `<div class="lh-settings"><div class="lh-section-title"><div><h2>主持模型</h2><p>适用于所有存档</p></div><button data-action="profile-new">新增连接</button></div>
      <div class="lh-profiles">${this.settings.profiles.map(item => `<button data-action="profile-select" data-id="${escape(item.id)}" class="${item.id === p.id ? 'lh-selected' : ''}">${escape(item.name)}${item.id === this.settings.activeProfileId ? ' · 使用中' : ''}</button>`).join('')}</div>
      <div class="lh-form-grid"><label>连接名称<input data-profile="name" value="${escape(p.name)}"></label><label>接口类型<select data-profile="protocol"><option value="openai">OpenAI 兼容</option><option value="anthropic">Anthropic</option><option value="google">Google Gemini</option></select></label>
      <label class="lh-wide">接口地址<input data-profile="baseUrl" type="url" placeholder="https://你的接口地址/v1" value="${escape(p.baseUrl)}" autocomplete="off"></label>
      <label class="lh-wide">API Key<input data-profile="apiKey" type="password" value="${escape(p.apiKey)}" autocomplete="new-password" spellcheck="false"></label>
      <label class="lh-wide">模型<input data-profile="model" list="lh-models" value="${escape(p.model)}" placeholder="选择或手动填写模型名"><datalist id="lh-models">${this.models.map(model => `<option value="${escape(model)}"></option>`).join('')}</datalist></label>
      <label>最大回复 Token<input data-profile="maxTokens" type="number" min="1" max="128000" value="${escape(p.maxTokens)}"></label><label>温度<input data-profile="temperature" type="number" min="0" max="2" step="0.1" value="${escape(p.temperature)}"></label><label class="lh-wide">模型上下文容量 Token<input data-profile="contextWindow" type="number" min="4096" max="2000000" value="${escape(p.contextWindow || 128000)}"></label></div>
      <div class="lh-buttons"><button data-action="models" ${this.modelConnecting ? 'disabled' : ''}>${this.modelConnecting ? '正在连接…' : '连接并获取模型'}</button><button data-action="profile-save" class="lh-primary">保存并使用</button>${this.settings.profiles.some(item => item.id === p.id) ? '<button data-action="profile-delete" class="lh-danger">删除连接</button>' : ''}</div><p class="lh-feedback" role="status">${escape(this.modelFeedback || '')}</p>
      <hr><h2>主持提示词</h2><label class="lh-field"><textarea id="lh-prompt" rows="7" aria-label="主持系统提示词">${escape(this.promptDraft)}</textarea></label><label class="lh-field">读取最近的酒馆消息数量<input id="lh-context-limit" type="number" min="1" max="200" value="${this.contextLimitDraft ?? this.settings.contextLimit}"></label><label class="lh-auto-compact"><input id="lh-auto-compact" type="checkbox" ${(this.autoCompactDraft ?? this.settings.autoCompact) ? 'checked' : ''}>接近上下文容量时自动压缩较早主持对话</label><button data-action="prompt-save" class="lh-primary">保存提示词与上下文设置</button></div>`;
    main.querySelector('[data-profile="protocol"]').value = p.protocol;
    for (const input of main.querySelectorAll('[data-profile]')) input.oninput = () => { p[input.dataset.profile] = input.value; this.profileDrafts.set(p.id, structuredClone(p)); this.settingsDirty = true; };
    main.querySelector('#lh-prompt').oninput = event => { this.promptDraft = event.target.value; this.promptDirty = true; this.settingsDirty = true; };
    main.querySelector('#lh-context-limit').oninput = event => { this.contextLimitDraft = event.target.value; this.promptDirty = true; this.settingsDirty = true; };
    main.querySelector('#lh-auto-compact').onchange = event => { this.autoCompactDraft = event.target.checked; this.promptDirty = true; this.settingsDirty = true; };
    const commands = document.createElement('section'); commands.className = 'lh-command-settings';
    commands.innerHTML = `<hr><h2>主持指令</h2><div class="lh-command-toggles">${BUILTIN_COMMANDS.map(c => `<label><input type="checkbox" data-command-enable="${c.name}" ${this.disabledCommandDrafts.has(c.name) ? '' : 'checked'}><span>/${c.name}</span><small>${escape(c.description)}</small></label>`).join('')}</div><h3>自定义提示词指令</h3><div class="lh-custom-commands">${this.commandDrafts.map((c, i) => `<div class="lh-custom-command" data-index="${i}"><label>指令名<input data-command-field="name" aria-label="指令名" value="${escape(c.name)}" placeholder="例如 recap"></label><label>用途<input data-command-field="description" aria-label="指令用途" value="${escape(c.description)}"></label><label>提示词<textarea data-command-field="template" aria-label="指令提示词" placeholder="可用 {input} 插入指令后的文字">${escape(c.template)}</textarea></label><button data-action="command-delete" data-index="${i}">删除指令</button></div>`).join('')}</div><div class="lh-buttons"><button data-action="command-new">新增指令</button><button class="lh-primary" data-action="commands-save">保存指令设置</button></div>`;
    main.querySelector('.lh-settings').append(commands);
    for (const input of commands.querySelectorAll('[data-command-enable]')) input.onchange = () => { if (input.checked) this.disabledCommandDrafts.delete(input.dataset.commandEnable); else this.disabledCommandDrafts.add(input.dataset.commandEnable); this.commandsDirty = true; this.settingsDirty = true; };
    for (const input of commands.querySelectorAll('[data-command-field]')) input.oninput = () => { this.commandDrafts[Number(input.closest('[data-index]').dataset.index)][input.dataset.commandField] = input.value; this.commandsDirty = true; this.settingsDirty = true; };
  }
  async renderDocuments() {
    const main = this.root.querySelector('.lh-main');
    main.innerHTML = `<section class="lh-documents"><aside class="lh-doc-sidebar"><div class="lh-section-title"><h2>游戏资料</h2><label class="lh-file-button">导入<input id="lh-import" type="file" accept=".md,.txt,.json" multiple hidden></label></div><input id="lh-doc-search" type="search" placeholder="搜索资料内容" value="${escape(this.docQuery || '')}" aria-label="搜索资料"><div class="lh-doc-list"></div></aside><section class="lh-doc-view"><h2>选择一份资料</h2><p>原策划与游戏内容</p></section></section>`;
    main.querySelector('#lh-import').onchange = async event => {
      try { if (!this.library?.catalog) throw new Error(this.libraryError || '资料库尚未加载。'); const n = await this.library.importFiles(event.target.files); this.error = ''; await this.renderDocuments(); this.toast(`已导入 ${n} 份资料`); }
      catch (error) { this.error = error.message; this.renderAlert(); }
    };
    main.querySelector('#lh-doc-search').oninput = event => { this.docQuery = event.target.value; clearTimeout(this.searchTimer); this.searchTimer = setTimeout(() => this.updateDocList(), 220); };
    await this.updateDocList();
    if (this.selectedDoc) this.openDoc(this.selectedDoc).catch(() => {});
  }
  async updateDocList() {
    const list = this.root.querySelector('.lh-doc-list'); if (!list) return;
    if (!this.library?.catalog) { list.textContent = this.libraryError || '正在加载资料…'; return; }
    this.searchController?.abort(); this.searchController = new AbortController(); const controller = this.searchController;
    list.textContent = '读取中…';
    try {
      const records = await this.library.search(this.docQuery || '', controller.signal);
      if (controller.signal.aborted || !list.isConnected) return;
      list.replaceChildren();
      if (!records.length) { list.textContent = '没有找到对应资料。'; return; }
      const groups = new Map();
      for (const record of records) {
        const folder = record.path.split('/').slice(0, -1).join('/');
        if (!groups.has(folder)) { const details = document.createElement('details'); details.open = Boolean(this.docQuery); const summary = document.createElement('summary'); summary.textContent = folder; details.append(summary); list.append(details); groups.set(folder, details); }
        const button = document.createElement('button'); button.dataset.action = 'doc-open'; button.dataset.id = record.id; button.textContent = record.title; button.title = record.path;
        groups.get(folder).append(button);
      }
    } catch (error) { if (!controller.signal.aborted) list.textContent = error.message; }
  }
  async openDoc(id) {
    this.selectedDoc = id; const doc = await this.library.read(id);
    const view = this.root.querySelector('.lh-doc-view'); if (!view || this.selectedDoc !== id) return;
    view.innerHTML = `<button class="lh-mobile-back" data-action="doc-back">‹ 资料目录</button><div class="lh-section-title"><h2>${escape(doc.title)}</h2><div class="lh-buttons"><button data-action="doc-source">${this.docSource ? '阅读视图' : '查看原文'}</button><button data-action="doc-attach" data-id="${escape(id)}">${this.session.selectedDocs.includes(id) ? '取消附加' : '附加到对话'}</button></div></div><small>${escape(doc.path)}</small><article class="lh-doc-content"></article>`;
    const body = view.querySelector('.lh-doc-content');
    if (/\.md$/i.test(doc.path) && !this.docSource) this.markdown(body, doc.content, doc.path);
    else { const pre = document.createElement('pre'); pre.textContent = doc.content; body.append(pre); }
    this.root.querySelector('.lh-documents').classList.add('lh-doc-reading');
  }
  showPreview(text, readOnly = false) {
    if (!readOnly) { this.session.handoff = text; this.saveSoon(); }
    this.root.querySelector('.lh-modal')?.remove();
    const modal = document.createElement('section'); modal.className = 'lh-modal'; modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-label', '交给酒馆');
    modal.innerHTML = `<header><h2>交给酒馆</h2><button data-action="preview-close" aria-label="关闭预览">×</button></header><textarea id="lh-handoff" aria-label="交给酒馆的内容"></textarea><p>确认后填入输入框，由你发送。</p><div class="lh-buttons"><button data-action="handoff" data-mode="append">追加到输入框</button><button data-action="handoff" data-mode="replace" class="lh-primary">填入／替换输入框</button></div>`;
    modal.querySelector('textarea').value = text;
    if (readOnly) {
      modal.querySelector('textarea').readOnly = true;
      modal.querySelector('h2').textContent = '酒馆上下文'; modal.querySelector('.lh-buttons').remove();
      modal.querySelector('p').textContent = '使用当前选中的回复版本。';
    } else modal.querySelector('textarea').oninput = event => { this.session.handoff = event.target.value; this.saveSoon(); };
    this.root.querySelector('.lh-panel').append(modal); modal.querySelector('textarea').focus();
  }
  toast(message) { this.error = message; this.renderAlert(); }
  download() {
    const blob = new Blob([JSON.stringify({ format: 'lantern-host-session', chat: this.key, session: this.session }, null, 2)], { type: 'application/json' });
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = '灯火之外-主持记录.json'; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }
  async action(action, button) {
    if (action === 'retry-save') { await this.persist(); return; }
    if (action === 'export') { this.download(); return; }
    if (action === 'command-insert') { this.session.draft = `/${button.dataset.name} `; this.saveSoon(); const input = this.root.querySelector('#lh-input'); input.value = this.session.draft; this.renderCommandMenu(); input.focus(); return; }
    if (action === 'command-new') { this.commandDrafts.push({ name: '', description: '', template: '' }); this.commandsDirty = true; this.settingsDirty = true; this.render(); return; }
    if (action === 'command-delete') { this.commandDrafts.splice(Number(button.dataset.index), 1); this.commandsDirty = true; this.settingsDirty = true; this.render(); return; }
    if (action === 'commands-save') {
      const next = { ...structuredClone(this.settings), customCommands: validateCommands(this.commandDrafts), disabledCommands: [...this.disabledCommandDrafts] };
      await this.bridge.saveSettings(next); this.settings = normalizeSettings(next); this.commandDrafts = structuredClone(next.customCommands); this.commandsDirty = false;
      this.settingsDirty = this.promptDirty || this.profileDrafts.size > 0; this.toast('指令设置已保存'); return;
    }
    if (action === 'profile-new') { this.profileDraft = { id: crypto.randomUUID(), name: '新连接', protocol: 'openai', baseUrl: '', apiKey: '', model: '', maxTokens: 4096, temperature: 0.7 }; this.models = []; this.render(); }
    if (action === 'profile-select') { this.profileDraft = structuredClone(this.profileDrafts.get(button.dataset.id) || this.settings.profiles.find(p => p.id === button.dataset.id)); this.models = []; this.modelFeedback = ''; this.render(); }
    if (action === 'models') {
      this.modelConnecting = true; this.modelFeedback = ''; this.render();
      const id = this.profileDraft.id;
      try { const result = await this.model.resolve(structuredClone(this.profileDraft), AbortSignal.timeout(60000), true); if (this.profileDraft.id === id) { this.models = result.models; this.profileDraft.baseUrl = result.baseUrl; this.profileDrafts.set(id, structuredClone(this.profileDraft)); this.settingsDirty = true; this.modelFeedback = `连接成功，找到 ${result.models.length} 个模型，请选择后保存。`; } }
      finally { this.modelConnecting = false; this.render(); }
    }
    if (action === 'profile-save' || action === 'profile-delete' || action === 'prompt-save') {
      const next = structuredClone(this.settings);
      if (action === 'profile-save') {
        const profile = structuredClone(this.profileDraft);
        if (!profile.name?.trim() || !profile.model?.trim() || !profile.baseUrl?.trim()) throw new Error('请填写连接名称、接口地址和模型。');
        connectionPayload(profile);
        if (!(Number(profile.maxTokens) > 0 && Number(profile.maxTokens) <= 128000)) throw new Error('最大回复 Token 应为 1—128000。');
        if (!(Number(profile.temperature) >= 0 && Number(profile.temperature) <= 2)) throw new Error('温度应为 0—2。');
        profile.contextWindow = Number(profile.contextWindow) || 128000;
        if (!Number.isInteger(profile.contextWindow) || profile.contextWindow < 4096 || profile.contextWindow > 2000000) throw new Error('模型上下文容量应为 4096—2000000 Token。');
        if (contextBudget(profile).inputLimit < 512) throw new Error('请为输入上下文预留空间：降低最大回复 Token，或提高模型上下文容量。');
        next.profiles = next.profiles.filter(p => p.id !== profile.id); next.profiles.push(profile); next.activeProfileId = profile.id;
      }
      if (action === 'profile-delete') { next.profiles = next.profiles.filter(p => p.id !== this.profileDraft.id); if (next.activeProfileId === this.profileDraft.id) next.activeProfileId = next.profiles[0]?.id || ''; }
      if (action === 'prompt-save') { next.systemPrompt = this.promptDraft; next.contextLimit = Math.max(1, Math.min(200, Number(this.root.querySelector('#lh-context-limit').value) || 30)); next.autoCompact = this.autoCompactDraft ?? this.settings.autoCompact; }
      button.disabled = true;
      try {
        await this.bridge.saveSettings(next); this.settings = normalizeSettings(next);
        if (action === 'prompt-save') this.promptDirty = false;
        else this.profileDrafts.delete(this.profileDraft.id);
        this.settingsDirty = this.promptDirty || this.commandsDirty || this.profileDrafts.size > 0;
        this.modelFeedback = '已保存'; if (action === 'profile-delete') this.profileDraft = null; this.render();
      }
      finally { button.disabled = false; }
    }
    if (action === 'context') {
      const snapshot = this.bridge.snapshot(this.settings.contextLimit);
      this.showPreview(JSON.stringify(snapshot, null, 2), true);
    }
    if (action === 'edit-message') { if (this.busy) return; this.session.editDraft = { messageId: button.dataset.id, text: this.session.messages.find(m => m.id === button.dataset.id)?.content || '' }; this.saveSoon(); this.render(); this.root.querySelector('.lh-inline-editor textarea')?.focus(); }
    if (action === 'edit-cancel') { this.session.editDraft = null; this.saveSoon(); this.render(); }
    if (action === 'version-prev' || action === 'version-next') { if (this.busy) return; switchVersion(this.session, button.dataset.id, action === 'version-prev' ? -1 : 1); this.saveSoon(); this.render(); }
    if (action === 'retry') await this.send({ retryId: button.dataset.id });
    if (action === 'compact') await this.compactNow();
    if (action === 'preview') this.showPreview(this.session.messages.find(m => m.id === button.dataset.id)?.content || '');
    if (action === 'preview-draft') this.showPreview(this.session.handoff);
    if (action === 'preview-close') this.root.querySelector('.lh-modal')?.remove();
    if (action === 'handoff') { const key = this.key, text = this.session.handoff; await this.persist(); if (key !== this.bridge.key()) throw new Error('聊天已切换，请回到原聊天确认。'); this.bridge.fill(text, button.dataset.mode); this.root.querySelector('.lh-modal')?.remove(); this.close(true); }
    if (action === 'doc-open') await this.openDoc(button.dataset.id);
    if (action === 'doc-back') this.root.querySelector('.lh-documents')?.classList.remove('lh-doc-reading');
    if (action === 'doc-source') { this.docSource = !this.docSource; await this.openDoc(this.selectedDoc); }
    if (action === 'doc-attach') {
      if (!this.key) throw new Error('请先打开一段酒馆聊天。');
      const id = button.dataset.id;
      this.session.selectedDocs = this.session.selectedDocs.includes(id) ? this.session.selectedDocs.filter(x => x !== id) : [...this.session.selectedDocs, id];
      await this.persist(); await this.openDoc(id);
    }
  }
  destroy() {
    this.stop(); clearTimeout(this.draftTimer); clearTimeout(this.searchTimer); this.searchController?.abort();
    this.cache();
    for (const cleanup of this.cleanups) cleanup(); this.root.remove(); this.settingsEntry.remove(); this.quickEntry.remove();
  }
}

export async function enable() {
  if (application) return application;
  if (initializing) return initializing;
  initializing = (async () => {
    const bridge = new TavernBridge(); await bridge.init();
    const store = new LocalStore(bridge.account); await store.ready;
    const app = new HostWorkspace(bridge, store); application = app;
    try { await app.init(); } catch (error) { app.destroy(); application = null; throw error; }
    globalThis.LanternHost = Object.freeze({ open: () => app.open(), close: () => app.close(), getStatus: () => ({ chatBound: Boolean(app.key), busy: app.busy, saveError: Boolean(app.saveError), version: '0.2.0' }) });
    return app;
  })().finally(() => { initializing = null; });
  return initializing;
}
export function disable() { application?.destroy(); application = null; delete globalThis.LanternHost; }
async function boot() { try { await enable(); } catch (error) { console.error('[灯火之外] 扩展初始化失败', error.message); globalThis.toastr?.error(error.message, '灯火之外'); } }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true }); else boot();
