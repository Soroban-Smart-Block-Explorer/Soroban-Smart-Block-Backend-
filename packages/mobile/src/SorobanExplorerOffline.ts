import { SorobanExplorerConfig, SyncDelta, SyncStatus } from './types';

interface SQLiteProvider {
  execute(sql: string, params?: unknown[]): Promise<unknown>;
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  runTransaction(callback: () => Promise<void>): Promise<void>;
}

interface NetworkStatusProvider {
  isOnline(): boolean;
  onStatusChange(callback: (online: boolean) => void): () => void;
}

interface BatteryProvider {
  getLevel(): Promise<number>;
  onLevelChange(callback: (level: number) => void): () => void;
}

export class SorobanExplorerOffline {
  private config: SorobanExplorerConfig;
  private db: SQLiteProvider;
  private network: NetworkStatusProvider;
  private battery: BatteryProvider;
  private replicaId: string;
  private lamport: number = 0;
  private isSyncing: boolean = false;
  private storageLimit: number = 100 * 1024 * 1024;
  private syncCallbacks: Set<(status: SyncStatus) => void> = new Set();

  constructor(
    config: SorobanExplorerConfig,
    db: SQLiteProvider,
    network: NetworkStatusProvider,
    battery: BatteryProvider,
  ) {
    this.config = config;
    this.db = db;
    this.network = network;
    this.battery = battery;
    this.replicaId = `replica_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    this.storageLimit = (config.offlineConfig?.storageLimitMB ?? 100) * 1024 * 1024;
  }

  async initialize(): Promise<void> {
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS soroban_cache (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        data TEXT NOT NULL,
        lamport INTEGER NOT NULL DEFAULT 0,
        replica_id TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        last_synced_at TEXT,
        last_accessed_at TEXT NOT NULL
      )
    `);
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS soroban_offline_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        body TEXT,
        created_at TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0
      )
    `);
    await this.db.execute('PRAGMA journal_mode=WAL');
    await this.db.execute('PRAGMA synchronous=NORMAL');
  }

  async getCached<T>(entityType: string, id: string): Promise<T | null> {
    const rows = await this.db.query<{ data: string }>(
      'SELECT data FROM soroban_cache WHERE id = ? AND entity_type = ? AND deleted = 0',
      [id, entityType],
    );
    if (rows.length === 0) return null;
    await this.touchAccess(id);
    return JSON.parse(rows[0].data) as T;
  }

  async query<T>(entityType: string, predicate?: (item: T) => boolean): Promise<T[]> {
    const rows = await this.db.query<{ data: string }>(
      'SELECT data FROM soroban_cache WHERE entity_type = ? AND deleted = 0',
      [entityType],
    );
    const items = rows.map((r) => JSON.parse(r.data) as T);
    return predicate ? items.filter(predicate) : items;
  }

  async set<T>(entityType: string, id: string, data: T): Promise<void> {
    this.lamport++;
    await this.db.execute(
      `INSERT OR REPLACE INTO soroban_cache (id, entity_type, data, lamport, replica_id, deleted, last_accessed_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)`,
      [
        id,
        entityType,
        JSON.stringify(data),
        this.lamport,
        this.replicaId,
        new Date().toISOString(),
      ],
    );
    await this.enforceStorageLimit();
  }

  async delete(entityType: string, id: string): Promise<void> {
    this.lamport++;
    await this.db.execute(
      'UPDATE soroban_cache SET deleted = 1, lamport = ? WHERE id = ? AND entity_type = ?',
      [this.lamport, id, entityType],
    );
  }

  async sync(): Promise<SyncStatus> {
    if (this.isSyncing) return this.getStatus();
    this.isSyncing = true;
    this.emitSyncStatus();

    try {
      const localLamport = await this.getMaxLamport();
      const response = await fetch(
        `${this.config.baseUrl}/api/v1/sync/delta?since=${localLamport}`,
        { headers: this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {} },
      );

      if (!response.ok) {
        this.isSyncing = false;
        this.emitSyncStatus();
        return this.getStatus();
      }

      const delta: SyncDelta = await response.json();

      await this.db.runTransaction(async () => {
        for (const record of delta.created) {
          await this.db.execute(
            `INSERT OR IGNORE INTO soroban_cache (id, entity_type, data, lamport, replica_id, deleted, last_synced_at, last_accessed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              record.id,
              record.data,
              JSON.stringify(record.data),
              record.lamport,
              record.replicaId,
              record.deleted ? 1 : 0,
              record.lastSyncedAt,
              new Date().toISOString(),
            ],
          );
        }
        for (const record of delta.updated) {
          await this.mergeRecord(record);
        }
        for (const id of delta.deleted) {
          await this.db.execute('UPDATE soroban_cache SET deleted = 1 WHERE id = ?', [id]);
        }
      });
    } catch {
      // sync failed, will retry
    }

    this.isSyncing = false;
    this.emitSyncStatus();
    return this.getStatus();
  }

  private async mergeRecord(record: {
    id: string;
    data: unknown;
    lamport: number;
    replicaId: string;
    deleted: boolean;
    lastSyncedAt: string;
  }): Promise<void> {
    const existing = await this.db.query<{ lamport: number; replica_id: string }>(
      'SELECT lamport, replica_id FROM soroban_cache WHERE id = ?',
      [record.id],
    );

    if (existing.length === 0) {
      await this.db.execute(
        `INSERT INTO soroban_cache (id, entity_type, data, lamport, replica_id, deleted, last_synced_at, last_accessed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.id,
          record.data,
          JSON.stringify(record.data),
          record.lamport,
          record.replicaId,
          record.deleted ? 1 : 0,
          record.lastSyncedAt,
          new Date().toISOString(),
        ],
      );
      return;
    }

    const local = existing[0] as { lamport: number; replica_id: string };
    if (
      record.lamport > local.lamport ||
      (record.lamport === local.lamport && record.replicaId > local.replica_id)
    ) {
      await this.db.execute(
        'UPDATE soroban_cache SET data = ?, lamport = ?, replica_id = ?, deleted = ?, last_synced_at = ? WHERE id = ?',
        [
          JSON.stringify(record.data),
          record.lamport,
          record.replicaId,
          record.deleted ? 1 : 0,
          record.lastSyncedAt,
          record.id,
        ],
      );
    }
  }

  async getStatus(): Promise<SyncStatus> {
    const pendingUploads = await this.db.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM soroban_cache WHERE replica_id = ? AND last_synced_at IS NULL',
      [this.replicaId],
    );
    const storageUsed = await this.getStorageUsed();
    return {
      lastSyncTimestamp: null,
      pendingUploads: pendingUploads[0]?.count ?? 0,
      pendingDownloads: 0,
      storageUsedMB: Math.round((storageUsed / (1024 * 1024)) * 100) / 100,
      isSyncing: this.isSyncing,
    };
  }

  onSyncStatus(callback: (status: SyncStatus) => void): () => void {
    this.syncCallbacks.add(callback);
    return () => this.syncCallbacks.delete(callback);
  }

  private emitSyncStatus(): void {
    this.getStatus().then((status) => {
      this.syncCallbacks.forEach((cb) => cb(status));
    });
  }

  private async getMaxLamport(): Promise<number> {
    const rows = await this.db.query<{ max: number }>(
      'SELECT COALESCE(MAX(lamport), 0) as max FROM soroban_cache',
    );
    return rows[0]?.max ?? 0;
  }

  private async touchAccess(id: string): Promise<void> {
    await this.db.execute('UPDATE soroban_cache SET last_accessed_at = ? WHERE id = ?', [
      new Date().toISOString(),
      id,
    ]);
  }

  private async enforceStorageLimit(): Promise<void> {
    const used = await this.getStorageUsed();
    if (used <= this.storageLimit) return;
    await this.db.execute(
      `DELETE FROM soroban_cache WHERE id IN (
        SELECT id FROM soroban_cache WHERE deleted = 0 ORDER BY last_accessed_at ASC LIMIT ?
      )`,
      [Math.max(10, Math.ceil((used - this.storageLimit) / 1024))],
    );
  }

  private async getStorageUsed(): Promise<number> {
    const rows = await this.db.query<{ total: number }>(
      'SELECT COALESCE(SUM(LENGTH(data)), 0) as total FROM soroban_cache WHERE deleted = 0',
    );
    return rows[0]?.total ?? 0;
  }
}
