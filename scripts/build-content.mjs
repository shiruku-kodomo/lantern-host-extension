import { readdir, readFile, mkdir, writeFile, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPanels } from '../src/rules.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = path.resolve(process.argv[2] || path.join(root, '../../3.策划文档'));
const target = path.join(root, 'content');
const sections = ['1.整体定位', '2.核心玩法', '3.游戏内容'];
const hash = value => createHash('sha256').update(value).digest('hex');
async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(full));
    else if (/\.(md|txt)$/i.test(entry.name)) result.push(full);
  }
  return result;
}
await mkdir(target, { recursive: true });
const catalog = { version: 1, source: '3.策划文档：整体定位、核心玩法、游戏内容（原文）', entries: [] };
for(const file of await readdir(target))if(/^part-\d+\.json$/.test(file))await unlink(path.join(target,file));
let part = {}, partBytes = 0, partNumber = 1;
async function flush() {
  if (!Object.keys(part).length) return;
  await writeFile(path.join(target, `part-${partNumber}.json`), JSON.stringify(part));
  part = {}; partBytes = 0; partNumber++;
}
for (const section of sections) {
  for (const full of await files(path.join(source, section))) {
    const content = await readFile(full, 'utf8');
    const docPath = path.relative(source, full).split(path.sep).join('/');
    if (partBytes > 250000) await flush();
    const id = hash(docPath).slice(0, 24);
    const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.basename(full);
    part[id] = content; partBytes += Buffer.byteLength(content);
    const canonicalId=content.match(/\*\*固定标识\*\*\s*`([^`]+)`/)?.[1]||`document:${id}`;
    const aliases=[title,...[...content.matchAll(/^(?:name|nicknames|名称|代号)\s*[:：]\s*(.+)$/gm)].map(m=>m[1].trim())];
    const fields=Object.fromEntries(Object.entries(extractPanels(content)).flatMap(([form,panel])=>Object.entries(panel).map(([field,value])=>[`forms.${form}.${field}`,{value,source:'原文面板解析',version:hash(content)}])));
    catalog.entries.push({ id, entityId:canonicalId, aliases:[...new Set(aliases)], fields, path: docPath, title, part: `part-${partNumber}.json`, bytes: Buffer.byteLength(content), sha256: hash(content) });
  }
}
await flush();
await writeFile(path.join(target, 'catalog.json'), JSON.stringify(catalog, null, 2));
console.log(`Bundled ${catalog.entries.length} original documents in ${partNumber - 1} shards.`);
