import { readSession, serializedQueue } from './core.js';

// The local envelope distinguishes an unsynced draft from a confirmed server copy.
export class SessionRepository {
  constructor(bridge, store) {
    this.bridge = bridge; this.store = store; this.records = new Map(); this.queue = serializedQueue();
  }
  async load(key) {
    const local = await this.store.get(`chat:${key}`);
    const remote = this.bridge.savedSession() ?? null;
    const remoteBase = JSON.stringify(remote);
    const record = local?.format === 'lantern-local-v1' ? local : local ? { session: local, base: remoteBase, dirty: local.revision > (remote?.revision ?? -1) } : null;
    const useLocal = record?.dirty;
    const session = readSession(useLocal ? record.session : remote);
    const base = useLocal ? record.base : remoteBase;
    const dirty = Boolean(useLocal && JSON.stringify(session) !== remoteBase);
    this.records.set(key, { session: structuredClone(session), base: dirty ? base : remoteBase, dirty, epoch: 0 });
    return { session, dirty };
  }
  cache(key, session) {
    const prior = this.records.get(key) || { base: 'null', epoch: 0 };
    const record = { ...prior, session: structuredClone(session), dirty: true, epoch: prior.epoch + 1 };
    this.records.set(key, record);
    return this.write(key, record);
  }
  write(key, record) { return this.store.put(`chat:${key}`, { format: 'lantern-local-v1', ...record }); }
  async sync(key, session) {
    await this.cache(key, session);
    const snapshot = structuredClone(session);
    return this.queue(async () => {
      if (this.bridge.key() !== key) return false;
      const base = this.records.get(key).base;
      await this.bridge.saveSession(key, snapshot, base);
      const record = this.records.get(key);
      record.base = JSON.stringify(snapshot);
      record.dirty = JSON.stringify(record.session) !== record.base;
      await this.write(key, record);
      return !record.dirty;
    });
  }
}
