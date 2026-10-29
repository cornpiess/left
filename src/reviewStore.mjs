import { isBrowseSnapshot } from './browseSession.mjs';
// Durable app-owned state. PhotoKit remains authoritative for assets/favorites.
export function createReviewStore({ open, readLegacy }) {
  let database;
  let initializing;
  let queue = Promise.resolve();
  const write = (task) => {
    const result = queue.catch(() => {}).then(async () => task(await init()));
    queue = result;
    return result;
  };
  async function init() {
    if (database) return database;
    if (initializing) return initializing;
    initializing = (async () => {
      const db = await open();
      await db.execAsync(`PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS asset_state (
          id TEXT PRIMARY KEY, reviewed_at INTEGER, pending_at INTEGER, size_bytes INTEGER);
        CREATE INDEX IF NOT EXISTS pending_idx ON asset_state(pending_at);
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS daily_usage (date TEXT PRIMARY KEY, used INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS cleanup_receipt (date TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(date,id));
        CREATE TABLE IF NOT EXISTS deletion_job (id TEXT PRIMARY KEY, payload TEXT NOT NULL);`);
      if (!(await db.getAllAsync('PRAGMA table_info(asset_state)')).some(column => column.name === 'size_bytes')) await db.execAsync('ALTER TABLE asset_state ADD COLUMN size_bytes INTEGER');
      if (!(await db.getFirstAsync("SELECT value FROM meta WHERE key='migration-v1'"))) {
        const legacy = await readLegacy(); // Failure must not mark migration complete.
        await db.withExclusiveTransactionAsync(async (tx) => {
          const viewed = [...new Set(legacy.viewed || [])];
          for (let i = 0; i < viewed.length; i += 400) {
            const batch = viewed.slice(i, i + 400);
            await tx.runAsync(`INSERT OR IGNORE INTO asset_state(id,reviewed_at) VALUES ${batch.map(() => '(?,1)').join(',')}`, ...batch);
          }
          let order = 1;
          for (const id of legacy.trash || []) {
            await tx.runAsync(`INSERT INTO asset_state(id,pending_at) VALUES (?,?)
              ON CONFLICT(id) DO UPDATE SET pending_at=excluded.pending_at`, id, order++);
          }
          await tx.runAsync("INSERT OR REPLACE INTO meta VALUES ('removed-bytes',?)", String(legacy.bytes || 0));
          if (legacy.quota?.date) await tx.runAsync('INSERT OR IGNORE INTO daily_usage VALUES (?,?)', legacy.quota.date, Math.max(0,legacy.quota.usedToday || 0));
          await tx.runAsync("INSERT INTO meta VALUES ('migration-v1','done')");
        });
      }
      // Browsed-photo usage must never consume the new cleaning allowance.
      if (!(await db.getFirstAsync("SELECT value FROM meta WHERE key='cleanup-policy-v1'"))) {
        await db.withExclusiveTransactionAsync(async tx => {
          await tx.runAsync('DELETE FROM daily_usage');
          await tx.runAsync("INSERT INTO meta VALUES ('cleanup-policy-v1','done')");
        });
      }
      database = db;
      return db;
    })().catch(error => { initializing = null; throw error; });
    return initializing;
  }
  async function putBrowse(tx, snapshot) {
    if (!snapshot || !isBrowseSnapshot(snapshot)) return false;
    const row = await tx.getFirstAsync("SELECT value FROM meta WHERE key='browse-session'");
    let previous;
    try { previous = row ? JSON.parse(row.value) : null; } catch {}
    if (snapshot.epoch !== (previous?.epoch || 0)) return false;
    if (previous?.sessionId && previous.sessionId !== snapshot.sessionId) return false;
    if (previous?.sessionId && previous.revision >= snapshot.revision) return false;
    await tx.runAsync("INSERT OR REPLACE INTO meta(key,value) VALUES ('browse-session',?)", JSON.stringify(snapshot));
    return true;
  }
  return {
    init,
    flush: () => queue,
    async loadBrowse() {
      await queue.catch(() => {});
      const row = await (await init()).getFirstAsync("SELECT value FROM meta WHERE key='browse-session'");
      try {
        const value = row ? JSON.parse(row.value) : null;
        return { epoch: Number.isSafeInteger(value?.epoch) ? value.epoch : 0, snapshot: isBrowseSnapshot(value) ? value : null, invalid: Boolean(value?.sessionId && !isBrowseSnapshot(value)) };
      } catch { return { epoch: 0, snapshot: null, invalid: true }; }
    },
    saveBrowse: snapshot => write(db => db.withExclusiveTransactionAsync(tx => putBrowse(tx, snapshot))),
    resetBrowse: () => write(db => db.withExclusiveTransactionAsync(async tx => {
      const row = await tx.getFirstAsync("SELECT value FROM meta WHERE key='browse-session'");
      let epoch = 0;
      try { epoch = JSON.parse(row?.value || '{}').epoch || 0; } catch {}
      await tx.runAsync("INSERT OR REPLACE INTO meta VALUES ('browse-session',?)", JSON.stringify({ epoch: ++epoch, revision: 0 }));
      return epoch;
    })),
    async load() {
      const db = await init();
      return {
        recent: (await db.getAllAsync('SELECT id FROM asset_state WHERE reviewed_at IS NOT NULL ORDER BY reviewed_at DESC LIMIT 2048')).map(r => r.id),
        trash: (await db.getAllAsync('SELECT id FROM asset_state WHERE pending_at IS NOT NULL ORDER BY pending_at')).map(r => r.id),
        count: (await db.getFirstAsync('SELECT COUNT(*) AS n FROM asset_state WHERE reviewed_at IS NOT NULL')).n,
        bytes: Number((await db.getFirstAsync("SELECT value FROM meta WHERE key='removed-bytes'"))?.value || 0),
      };
    },
    async reviewed(ids) {
      await queue.catch(() => {});
      const db = await init();
      const found = new Set();
      for (let i = 0; i < ids.length; i += 400) {
        const batch = ids.slice(i, i + 400);
        if (!batch.length) continue;
        const rows = await db.getAllAsync(`SELECT id FROM asset_state WHERE reviewed_at IS NOT NULL AND id IN (${batch.map(() => '?').join(',')})`, ...batch);
        rows.forEach(row => found.add(row.id));
      }
      return found;
    },
    review: id => write(async db => {
      const result = await db.runAsync(`INSERT INTO asset_state(id,reviewed_at) VALUES (?,?)
        ON CONFLICT(id) DO UPDATE SET reviewed_at=excluded.reviewed_at WHERE asset_state.reviewed_at IS NULL`, id, Date.now());
      return result.changes > 0;
    }),
    selectForCleanup: (id, { date, charge, limit, size = null, checkpoint }) => write(async db => {
      let result;
      await db.withExclusiveTransactionAsync(async tx => {
        const existing = await tx.getFirstAsync('SELECT pending_at FROM asset_state WHERE id=?', id);
        const receipt = await tx.getFirstAsync('SELECT id FROM cleanup_receipt WHERE date=? AND id=?', date, id);
        let used = Number((await tx.getFirstAsync('SELECT used FROM daily_usage WHERE date=?',date))?.used || 0);
        if (existing?.pending_at != null) { result = { allowed: true, changed: false, used }; return; }
        if (charge && !receipt && used >= limit) { result = { allowed: false, changed: false, used }; return; }
        await tx.runAsync(`INSERT INTO asset_state(id,pending_at,size_bytes) VALUES (?,?,?)
          ON CONFLICT(id) DO UPDATE SET pending_at=excluded.pending_at,size_bytes=COALESCE(excluded.size_bytes,asset_state.size_bytes)`,id,Date.now(),size);
        await tx.runAsync('INSERT OR IGNORE INTO cleanup_receipt VALUES (?,?)',date,id);
        if (charge && !receipt) {
          used++;
          await tx.runAsync('INSERT INTO daily_usage VALUES (?,?) ON CONFLICT(date) DO UPDATE SET used=excluded.used',date,used);
        }
        if (checkpoint) await putBrowse(tx, checkpoint());
        result = { allowed: true, changed: true, used };
      });
      return result;
    }),
    async dailyUsage(date) {
      await queue.catch(() => {});
      return Number((await (await init()).getFirstAsync('SELECT used FROM daily_usage WHERE date=?',date))?.used || 0);
    },
    resetQuota: date => write(db => db.withExclusiveTransactionAsync(async tx => {
      await tx.runAsync('INSERT INTO daily_usage VALUES (?,0) ON CONFLICT(date) DO UPDATE SET used=0',date);
      await tx.runAsync('DELETE FROM cleanup_receipt WHERE date=?',date);
    })),
    setPending: (id, pending, size = null, checkpoint) => write(db => db.withExclusiveTransactionAsync(async tx => {
      await tx.runAsync(`INSERT INTO asset_state(id,pending_at,size_bytes) VALUES (?,?,?)
      ON CONFLICT(id) DO UPDATE SET pending_at=excluded.pending_at,size_bytes=COALESCE(excluded.size_bytes,asset_state.size_bytes)`, id, pending ? Date.now() : null, size);
      if (checkpoint) await putBrowse(tx, checkpoint());
    })),
    async trashPage(limit, offset) {
      await queue.catch(() => {});
      return (await (await init()).getAllAsync('SELECT id,size_bytes FROM asset_state WHERE pending_at IS NOT NULL ORDER BY pending_at DESC,rowid DESC LIMIT ? OFFSET ?', limit, offset));
    },
    async trashSummary() {
      await queue.catch(() => {});
      return (await init()).getFirstAsync(`SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes),0) AS known_bytes,
        COALESCE(SUM(CASE WHEN size_bytes IS NULL OR size_bytes<=0 THEN 1 ELSE 0 END),0) AS unknown_count
        FROM asset_state WHERE pending_at IS NOT NULL`);
    },
    clearReviewed: () => write(db => db.runAsync('UPDATE asset_state SET reviewed_at=NULL')),
    beginDeletion: (id, payload) => write(db => db.runAsync('INSERT INTO deletion_job VALUES (?,?)', id, JSON.stringify(payload))),
    abandonDeletion: id => write(db => db.runAsync('DELETE FROM deletion_job WHERE id=?', id)),
    async jobs() { return (await (await init()).getAllAsync('SELECT * FROM deletion_job')).map(row => ({ id: row.id, ...JSON.parse(row.payload) })); },
    completeDeletion: (jobId, deletedIds, bytes, remaining = null) => write(async db => {
      let applied = false;
      await db.withExclusiveTransactionAsync(async tx => {
        if (!(await tx.getFirstAsync('SELECT id FROM deletion_job WHERE id=?', jobId))) return;
        applied = true;
        for (const id of deletedIds) await tx.runAsync('UPDATE asset_state SET pending_at=NULL WHERE id=?', id);
        await tx.runAsync("UPDATE meta SET value=CAST(value AS INTEGER)+? WHERE key='removed-bytes'", bytes);
        if (remaining?.ids.length) await tx.runAsync('UPDATE deletion_job SET payload=? WHERE id=?', JSON.stringify(remaining), jobId);
        else await tx.runAsync('DELETE FROM deletion_job WHERE id=?', jobId);
      });
      return applied;
    }),
  };
}

export class RecentIds extends Set {
  constructor(limit = 4096) { super(); this.limit = limit; }
  add(id) {
    if (this.has(id)) this.delete(id);
    super.add(id);
    while (this.size > this.limit) this.delete(this.values().next().value);
    return this;
  }
}

