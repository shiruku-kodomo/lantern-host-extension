import { emptySession, readSession, serializedQueue } from './core.js';

export const uid = () => crypto.randomUUID();
export const stable = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
export async function digest(value) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(typeof value === 'string' ? value : stable(value))))].map(v => v.toString(16).padStart(2, '0')).join(''); }
export function emptyWorld() { return { version: 1, revision: 0, time: 0, phase: 'daily', entities: {}, definitions: {}, items: {}, knowledge: {}, quests: {}, battles: {}, places: {}, routes: {}, effects: {}, claims: {}, targets: [], countries: {}, events: [], narrator: null, companion: null, nextStop: '等待开场', outcome: null }; }
export function branchKey(campaign, branch) { return `${campaign}:${branch}`; }

export class GameDatabase {
  constructor(store) { this.store = store; }
  async create(campaignId = uid(), branchId = uid(), session = emptySession()) {
    const branch = { campaignId, branchId, revision: 0, world: emptyWorld(), session, createdAt: Date.now() };
    await this.store.batch([{ store: 'campaigns', key: campaignId, value: { id: campaignId, createdAt: Date.now() } }, { store: 'branches', key: branchKey(campaignId, branchId), value: branch }]);
    return branch;
  }
  get(campaignId, branchId) { return this.store.read('branches', branchKey(campaignId, branchId)); }
  async commit(campaignId, branchId, event) {
    const key = branchKey(campaignId, branchId), eventKey = `${key}:${event.id}`;
    const fingerprint = await digest({ operations: event.operations, source: event.source });
    return this.store.atomic('branches', key, (branch, tx) => {
      if (!branch) throw new Error('本局记录不存在。');
      const prior = branch.world.events.find(e => e.id === event.id);
      if (prior) { if (prior.fingerprint !== fingerprint) throw new Error('EVENT_CONFLICT：同一事件的内容发生变化。'); return { ...prior, reused: true }; }
      if (branch.world.revision !== event.baseRevision) throw new Error('STATE_CONFLICT：状态已变化，请读取最新记录后继续。');
      const world = structuredClone(event.world);
      if (world.revision !== event.baseRevision) throw new Error('无效的结算版本。');
      world.revision++;
      const receipt = { id: event.id, fingerprint, revision: world.revision, operations: event.operations, source: event.source, before: branch.world, after: structuredClone(world), at: Date.now() };
      world.events = [...branch.world.events, { id: event.id, fingerprint, revision: world.revision, at: receipt.at }];
      branch.world = world; branch.revision++; tx.objectStore('branches').put(branch, key);
      tx.objectStore('events').put(receipt, eventKey);
      for (const [collection, store] of [['entities','entities'],['definitions','definitions'],['items','items'],['knowledge','knowledge'],['quests','quests']]) {
        for (const [id, value] of Object.entries(world[collection])) tx.objectStore(store).put({ campaignId, branchId, ...value }, `${key}:${id}`);
      }
      tx.objectStore('outbox').put({ campaignId, branchId, type: 'backup', revision: branch.revision }, key);
      return { id: receipt.id, revision: receipt.revision, reused: false };
    }, ['events', 'entities', 'definitions', 'items', 'knowledge', 'quests', 'outbox']);
  }
  async roll(campaignId, branchId, id, parameters, sample) {
    const key = `${branchKey(campaignId, branchId)}:${id}`, signature = stable(parameters);
    return this.store.atomic('rolls', key, (old, tx) => {
      if (old) { if (old.signature !== signature) throw new Error('CHECK_CONFLICT：已投检定的用途或参数不能更改。'); return { ...old, reused: true }; }
      const value = { id, campaignId, branchId, signature, ...sample(), parameters, at: Date.now() };
      tx.objectStore('rolls').put(value, key); return value;
    });
  }
  async archive(campaignId, branchId, turn) {
    const key = branchKey(campaignId, branchId), branch = await this.get(campaignId, branchId);
    await this.store.batch([{ store: 'turns', key: `${key}:${turn.id}`, value: { ...structuredClone(turn), campaignId, branchId, worldRevision: branch.world.revision, at: Date.now() } }, { store: 'snapshots', key: `${key}:${turn.userId}`, value: { world: turn.before, after: branch.world, campaignId, branchId } }]);
  }
  async fork(campaignId, branchId, userId, {after=false}={}) {
    const old = await this.get(campaignId, branchId);let snapshot = await this.store.read('snapshots', `${branchKey(campaignId, branchId)}:${userId}`);
    let parent=old.parentBranch;const visited=new Set([branchId]);while(!snapshot&&parent&&!visited.has(parent)){visited.add(parent);snapshot=await this.store.read('snapshots',`${branchKey(campaignId,parent)}:${userId}`);parent=(await this.get(campaignId,parent))?.parentBranch;}
    if(!snapshot){const run=(await this.store.list('runs',`${branchKey(campaignId,branchId)}:`)).find(r=>r.userId===userId);if(run)snapshot={world:run.before};else if(old.world.revision===0)snapshot={world:old.world};}
    if (!snapshot) throw new Error('这条历史行动没有可恢复的状态快照，不能在当前状态重新结算。');
    if(after&&!snapshot.after)throw new Error('该轮尚无完整结算快照，不能恢复为已完成回合。');
    const next = { ...old, branchId: uid(), worldbook:null, world: structuredClone(after?snapshot.after:snapshot.world), parentBranch: branchId, forkedAt: userId, revision: 0, createdAt: Date.now() };
    await this.store.write('branches', branchKey(campaignId, next.branchId), next); return next;
  }
}

export class CampaignSessions {
  constructor(bridge, store) { this.bridge = bridge; this.store = store; this.db = new GameDatabase(store); this.records = new Map(); this.queue = serializedQueue(); }
  async load(key) {
    const remote = this.bridge.savedSession(), alias = await this.store.read('bindings', key);
    let binding = remote?.format === 'lantern-campaign-v2' ? remote : alias;
    if(alias&&binding&&alias.campaignId===binding.campaignId&&alias.branchId!==binding.branchId&&await this.store.read('outbox',branchKey(alias.campaignId,alias.branchId)))binding=alias;
    let branch = binding && await this.db.get(binding.campaignId, binding.branchId);
    if (!branch && binding?.backup) {
      const data = await this.bridge.readBackup(binding.backup);
      if (data.branch.campaignId !== binding.campaignId || data.branch.branchId !== binding.branchId) throw new Error('备份与本局身份不符。');
      await this.store.batch(data.records.concat([{ store: 'branches', key: branchKey(binding.campaignId, binding.branchId), value: data.branch }]));
      branch = data.branch;
    }
    if(branch&&remote?.backup&&remote.revision>branch.world.revision){
      const pending=await this.store.read('outbox',branchKey(binding.campaignId,binding.branchId));if(pending)throw new Error('远端有较新结算且本机有未同步数据，请先导出本局，避免覆盖。');
      const data=await this.bridge.readBackup(remote.backup);await this.store.batch(data.records.concat([{store:'branches',key:branchKey(binding.campaignId,binding.branchId),value:data.branch}]));branch=data.branch;
    }
    if (!branch) {
      if (binding?.campaignId) throw new Error('本局数据库与备份均不可用，已阻止创建空档覆盖。请恢复原备份。');
      const local = await this.store.get(`chat:${key}`), rawLegacy = local?.session || (remote?.version === 1 ? remote : null), legacy = rawLegacy ? readSession(rawLegacy) : null;
      branch = await this.db.create(undefined, undefined, legacy || emptySession());
      binding = { format: 'lantern-campaign-v2', campaignId: branch.campaignId, branchId: branch.branchId, backup: null, migrated: !!legacy };
    }
    binding = { ...binding, format: 'lantern-campaign-v2' };
    await this.store.write('bindings', key, binding);
    this.records.set(key, { binding, base: JSON.stringify(remote ?? null), branch });
    return { session: branch.session, dirty: !!(await this.store.read('outbox', branchKey(branch.campaignId, branch.branchId))) };
  }
  current(key) { const record = this.records.get(key); if (!record) throw new Error('请先打开本局。'); return record; }
  cache(key, session) {
    const copy = structuredClone(session), record = this.current(key), k = branchKey(record.binding.campaignId, record.binding.branchId);
    return this.store.atomic('branches', k, (branch, tx) => { if ((branch.session?.revision || 0) > copy.revision) return; branch.session = copy; tx.objectStore('branches').put(branch, k); tx.objectStore('outbox').put({ type: 'backup', campaignId: branch.campaignId, branchId: branch.branchId }, k); }, ['outbox']);
  }
  sync(key, session) {
    const snapshot = structuredClone(session),requestedBranch=this.current(key).binding.branchId;
    return this.queue(async () => {
      if(this.current(key).binding.branchId!==requestedBranch)throw new Error('分支已经切换，旧版本保留在本地，等待当前分支同步。');
      await this.cache(key, snapshot);
      const record = this.current(key), { campaignId, branchId } = record.binding, k = branchKey(campaignId, branchId);
      const branch = await this.db.get(campaignId, branchId), records = [];
      const campaign=await this.store.read('campaigns',campaignId);if(campaign)records.push({store:'campaigns',key:campaignId,value:campaign});
      // Include historical branches so a database rebuild also restores version navigation.
      for(const savedBranch of await this.store.list('branches',`${campaignId}:`)){
        const savedKey=branchKey(campaignId,savedBranch.branchId);if(savedKey!==k)records.push({store:'branches',key:savedKey,value:savedBranch});
        for (const store of ['rolls','events','plans','runs','turns']) for (const value of await this.store.list(store, `${savedKey}:`)) records.push({ store, key: `${savedKey}:${value.id}`, value });
        for (const turn of await this.store.list('turns', `${savedKey}:`)) { const value = await this.store.read('snapshots', `${savedKey}:${turn.userId}`); if (value) records.push({ store: 'snapshots', key: `${savedKey}:${turn.userId}`, value }); }
      }
      const backup = await this.bridge.writeBackup({ format: 'lantern-backup-v2', branch, records });
      if(this.current(key).binding.branchId!==requestedBranch)throw new Error('分支已经切换，备份已保留，未覆盖当前绑定。');
      const metadata = { ...record.binding, backup, nativeChatKey:key, revision: branch.world.revision, updatedAt: Date.now() };
      await this.bridge.saveSession(key, metadata, record.base);
      record.base = JSON.stringify(metadata); record.binding = metadata; record.branch = branch;
      await this.store.write('bindings', key, metadata);
      const latest = await this.db.get(campaignId, branchId);
      if (latest.session.revision === snapshot.revision&&latest.world.revision===branch.world.revision) await this.store.batch([{ store: 'outbox', key: k, delete: true }]);
      return true;
    });
  }
  async fork(key, userId) {
    const record = this.current(key), next = await this.db.fork(record.binding.campaignId, record.binding.branchId, userId);
    record.binding = { ...record.binding, branchId: next.branchId, backup: null }; record.branch = next;
    await this.store.write('bindings', key, record.binding); return next;
  }
}
