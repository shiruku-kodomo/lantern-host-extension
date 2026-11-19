import { serializedQueue } from './core.js';
import {migrateRecord} from './migrations.js';
export const GAME_STORES = ['records', 'bindings', 'campaigns', 'branches', 'entities', 'definitions', 'items', 'knowledge', 'quests', 'rolls', 'events', 'plans', 'runs', 'turns', 'snapshots', 'outbox'];
const storageFailure = cause => Object.assign(new Error('本地保存未成功，可能是存储空间不足。请保留窗口并导出本局。', {cause}), {storageFailure:true});
export class LocalStore {
  constructor(account, factory = globalThis.indexedDB) {
    this.queue = serializedQueue();
    this.ready = new Promise((resolve, reject) => {
      if (!factory) { reject(new Error('当前宿主无法使用本地存储。')); return; }
      const req = factory.open(`lantern-host:${account}`, 2);
      req.onupgradeneeded = () => { for (const name of GAME_STORES) if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name); };
      req.onsuccess = () => { const db=req.result;db.onversionchange=()=>db.close();
        const stores=['records','branches','entities','definitions','quests','runs','snapshots'];const tx=db.transaction(stores,'readwrite'),marker=tx.objectStore('records').get('migration:world-v2');
        marker.onsuccess=()=>{if(marker.result===2)return;for(const name of stores.filter(n=>n!=='records')){const request=tx.objectStore(name).openCursor();request.onsuccess=()=>{const c=request.result;if(!c)return;const old=JSON.stringify(c.value),value=migrateRecord(name,c.value);if(JSON.stringify(value)!==old)c.update(value);c.continue();};}tx.objectStore('records').put(2,'migration:world-v2');};
        tx.oncomplete=()=>resolve(db);tx.onabort=tx.onerror=()=>reject(storageFailure(tx.error));
      };
      req.onerror = () => reject(new Error('无法打开主持本地存储。'));
      req.onblocked = () => reject(new Error('请关闭其他旧版主持页面后重试。'));
    });
  }
  async get(key) {
    return this.queue(async () => {
      const db = await this.ready;
      return new Promise((resolve, reject) => {
      const req = db.transaction('records').objectStore('records').get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new Error('读取本地记录失败。'));
      });
    });
  }
  put(key, value) {
    const copy = structuredClone(value);
    return this.queue(async () => {
      const db = await this.ready;
      return new Promise((resolve, reject) => {
        const tx = db.transaction('records', 'readwrite');
        tx.objectStore('records').put(copy, key);
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(storageFailure(tx.error));
      });
    });
  }
  async read(store, key) {
    const db = await this.ready;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store), req = tx.objectStore(store).get(key);
      let value; req.onsuccess = () => { value = migrateRecord(store,req.result); };
      tx.oncomplete = () => resolve(value); tx.onerror = tx.onabort = () => reject(tx.error || new Error('读取本局数据库失败。'));
    });
  }
  async list(store, prefix = '') {
    const db = await this.ready;
    return new Promise((resolve, reject) => {
      const values = [], tx = db.transaction(store), range=prefix&&globalThis.IDBKeyRange?IDBKeyRange.bound(prefix,`${prefix}\uffff`):undefined,request = tx.objectStore(store).openCursor(range);
      request.onsuccess = () => { const cursor = request.result; if (!cursor) return; if (String(cursor.key).startsWith(prefix)) values.push(migrateRecord(store,cursor.value)); cursor.continue(); };
      tx.oncomplete = () => resolve(values); tx.onerror = tx.onabort = () => reject(tx.error || new Error('读取记录失败。'));
    });
  }
  async write(store, key, value) { return this.batch([{ store, key, value }]); }
  async batch(operations) {
    const copies = structuredClone(operations), db = await this.ready;
    return new Promise((resolve, reject) => {
      const tx = db.transaction([...new Set(copies.map(o => o.store))], 'readwrite');
      for (const op of copies) { const store = tx.objectStore(op.store); if (op.delete) store.delete(op.key); else store.put(migrateRecord(op.store,op.value), op.key); }
      tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(storageFailure(tx.error));
    });
  }
  // The callback is synchronous: no network or model call can outlive this transaction.
  async atomic(store, key, update, stores = []) {
    const db = await this.ready;
    return new Promise((resolve, reject) => {
      const tx = db.transaction([...new Set([store, ...stores])], 'readwrite');
      const req = tx.objectStore(store).get(key); let result, failure;
      req.onsuccess = () => { try { result = update(migrateRecord(store,structuredClone(req.result)), tx); } catch (error) { failure = error; tx.abort(); } };
      tx.oncomplete = () => resolve(result); tx.onerror = tx.onabort = () => reject(failure || storageFailure(tx.error));
    });
  }
}
