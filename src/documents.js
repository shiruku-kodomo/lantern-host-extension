import { safePath } from './core.js';
export class DocumentLibrary {
  constructor(store, base = new URL('../content/', import.meta.url), fetcher = globalThis.fetch.bind(globalThis)) {
    this.store = store; this.base = base; this.fetch = fetcher; this.parts = new Map(); this.imports = [];
  }
  async init() {
    const response = await this.fetch(new URL('catalog.json', this.base));
    if (!response.ok) throw new Error('游戏资料包读取失败，请完整安装扩展后重试。');
    this.catalog = await response.json();
    this.imports = await this.store.get('documents') || [];
    return this;
  }
  list() { return [...this.catalog.entries, ...this.imports]; }
  async part(name) {
    if (!this.parts.has(name)) {
      const pending = this.fetch(new URL(name, this.base)).then(async response => {
        if (!response.ok) throw new Error('资料文件读取失败，请重试。');
        return response.json();
      }).catch(error => { this.parts.delete(name); throw error; });
      this.parts.set(name, pending);
    }
    return this.parts.get(name);
  }
  async read(id) {
    const record = this.list().find(d => d.id === id);
    if (!record) throw new Error('资料不存在或已移除。');
    return { ...record, content: record.content ?? (await this.part(record.part))[record.id] };
  }
  async search(query, signal) {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return this.list();
    const results = [];
    // Fetch each shard once; the source file is the authority, not a model summary.
    for (const record of this.list()) {
      signal?.throwIfAborted();
      const title = `${record.path} ${record.title}`.toLowerCase();
      if (words.every(w => title.includes(w))) { results.push(record); continue; }
      const doc = await this.read(record.id);
      const haystack = `${title}\n${doc.content}`.toLowerCase();
      if (words.every(w => haystack.includes(w))) results.push(record);
    }
    return results;
  }
  async importFiles(files) {
    const additions = [];
    let bytes = 0;
    for (const file of files) {
      bytes += file.size;
      if (bytes > 30 * 1024 * 1024) throw new Error('单次导入请控制在 30 MB 内，可分批导入。');
      if (!/\.(md|txt|json)$/i.test(file.name)) throw new Error(`暂不支持 ${file.name}，请选择 Markdown、TXT 或 JSON。`);
      const content = await file.text();
      const path = safePath(`导入资料/${file.webkitRelativePath || file.name}`);
      if (/\.json$/i.test(file.name)) { try { JSON.parse(content); } catch { throw new Error(`${file.name} 不是有效的 JSON 文件。`); } }
      additions.push({ id: `import:${path}`, path, title: file.name, content, imported: true });
    }
    const map = new Map(this.imports.map(d => [d.id, d]));
    for (const doc of additions) map.set(doc.id, doc);
    const next = [...map.values()];
    await this.store.put('documents', next);
    this.imports = next;
    return additions.length;
  }
}
