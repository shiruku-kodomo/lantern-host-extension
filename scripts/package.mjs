import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(await readFile(path.join(root, 'manifest.json'))).version;
const packageVersion=JSON.parse(await readFile(path.join(root,'package.json'))).version;
const runtimeVersion=(await readFile(path.join(root,'src/updater.js'),'utf8')).match(/export const VERSION=['"]([^'"]+)/)?.[1];
if(version!==packageVersion||version!==runtimeVersion)throw new Error('版本文件不一致，已阻止生成错误安装包。');
const now=new Date(),dosTime=(now.getHours()<<11)|(now.getMinutes()<<5)|(now.getSeconds()>>1),dosDate=((now.getFullYear()-1980)<<9)|((now.getMonth()+1)<<5)|now.getDate();
const names = ['manifest.json', 'package.json', 'index.js', 'styles.css', 'src', 'content', 'README.md', 'VALIDATION.md', 'CHANGELOG.md', 'INSTALL_VALIDATION.md', 'REVIEW_0.3.3.md', 'REVIEW_0.3.6.md', 'RULE_COVERAGE.md', 'BATTLE_TESTS.md', 'DICE_PROOF.md', 'LIVE_AGENT_PROOF.md', 'NOTICE.md', 'LICENSE', 'licenses'];
const entries = [];
async function collect(name) {
  const full = path.join(root, name);
  if (name.endsWith('/')) return;
  try {
    for (const entry of await readdir(full, { withFileTypes: true })) await collect(`${name}/${entry.name}`);
  } catch (error) {
    if (error.code !== 'ENOTDIR') throw error;
    entries.push({ name: `lantern-host-extension/${name}`, data: await readFile(full) });
  }
}
for (const name of names) await collect(name);
const crcTable = Array.from({ length: 256 }, (_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
const crc32 = data => { let crc = 0xffffffff; for (const b of data) crc = crcTable[(crc ^ b) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; };
let offset = 0;
const chunks = [], directory = [];
for (const { name, data } of entries) {
  const encoded = Buffer.from(name), compressed = deflateRawSync(data), crc = crc32(data);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8);
  local.writeUInt16LE(dosTime,10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(encoded.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(8, 10);
  central.writeUInt16LE(dosTime,12); central.writeUInt16LE(dosDate, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(encoded.length, 28); central.writeUInt32LE(offset, 42);
  chunks.push(local, encoded, compressed); directory.push(central, encoded); offset += local.length + encoded.length + compressed.length;
}
const dir = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
await mkdir(path.join(root, 'releases'), { recursive: true });
const destination = path.join(root, 'releases', `lantern-host-extension-${version}.zip`);
await writeFile(destination, Buffer.concat([...chunks, dir, end]));
console.log(destination);
