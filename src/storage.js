import { serializedQueue } from './core.js';
export class LocalStore {
  constructor(account, factory = globalThis.indexedDB) {
    this.queue = serializedQueue();
    this.ready = new Promise((resolve, reject) => {
      if (!factory) { reject(new Error('当前宿主无法使用本地存储。')); return; }
      const req = factory.open(`lantern-host:${account}`, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('records');
      req.onsuccess = () => resolve(req.result);
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
        tx.onerror = tx.onabort = () => reject(new Error('本地保存失败，可能是存储空间不足。请保留页面并导出备份。'));
      });
    });
  }
}
