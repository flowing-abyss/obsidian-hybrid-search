import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export const INDEX_LEASE_MS = 30_000;
export type IndexOwnerMode = 'background' | 'foreground' | 'bootstrap';
export interface IndexLease {
  readonly token: string;
  readonly mode: IndexOwnerMode;
}
export interface IndexProgress {
  queued: number;
  total: number;
  processed: number;
  isRunning: boolean;
}
export interface IndexOwnerSnapshot extends IndexProgress {
  token: string | null;
  mode: IndexOwnerMode | null;
  expiresAt: number;
  heartbeatSequence: number;
}
export interface StalledOwner {
  token: string;
  heartbeatSequence: number;
}
export interface IndexOwnershipStore {
  read(): IndexOwnerSnapshot;
  requestForeground(token: string): void;
  renewForegroundRequest(token: string): boolean;
  cancelForegroundRequest(token: string): void;
  claim(requestToken: string, mode: IndexOwnerMode, stalled?: StalledOwner): IndexLease | null;
  renew(lease: IndexLease, progress?: IndexProgress): boolean;
  release(lease: IndexLease): boolean;
  write<T>(lease: IndexLease, operation: () => T): T;
}

export class IndexLeaseLostError extends Error {
  constructor(message = 'Indexing ownership changed; stale work was discarded.') {
    super(message);
    this.name = 'IndexLeaseLostError';
  }
}

function initializeOwnership(db: Database.Database): void {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='index_owner'").get()) return;
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS index_owner (
        id INTEGER PRIMARY KEY CHECK (id = 1), token TEXT, mode TEXT,
        expires_at INTEGER NOT NULL DEFAULT 0,
        heartbeat_sequence INTEGER NOT NULL DEFAULT 0,
        queued INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0,
        processed INTEGER NOT NULL DEFAULT 0, is_running INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO index_owner(id) VALUES(1);
      CREATE TABLE IF NOT EXISTS index_waiters (
        ticket INTEGER PRIMARY KEY AUTOINCREMENT,
        token TEXT UNIQUE NOT NULL, expires_at INTEGER NOT NULL
      );
    `);
  }).immediate();
}

/** Control-plane transactions only touch ownership and waiter rows. */
export function createIndexOwnership(
  db: Database.Database,
  options: { now?: () => number; leaseMs?: number } = {},
): IndexOwnershipStore {
  const now = options.now ?? Date.now;
  const leaseMs = options.leaseMs ?? INDEX_LEASE_MS;
  initializeOwnership(db);
  let fencedTransactionToken: string | null = null;

  function read(): IndexOwnerSnapshot {
    const row = db
      .prepare(
        `SELECT token, mode, expires_at AS expiresAt,
      heartbeat_sequence AS heartbeatSequence, queued, total, processed,
      is_running AS isRunning FROM index_owner WHERE id=1`,
      )
      .get() as Omit<IndexOwnerSnapshot, 'isRunning'> & { isRunning: number };
    return { ...row, isRunning: row.isRunning !== 0 };
  }

  function pruneWaiters(time: number): void {
    db.prepare('DELETE FROM index_waiters WHERE expires_at <= ? OR expires_at > ?').run(
      time,
      time + leaseMs * 2,
    );
  }

  function requestForeground(token: string): void {
    db.transaction(() => {
      const time = now();
      pruneWaiters(time);
      db.prepare(
        `INSERT INTO index_waiters(token, expires_at) VALUES(?, ?)
        ON CONFLICT(token) DO UPDATE SET expires_at=excluded.expires_at`,
      ).run(token, time + leaseMs);
    }).immediate();
  }

  function renewForegroundRequest(token: string): boolean {
    return db
      .transaction(() => {
        const time = now();
        pruneWaiters(time);
        return (
          db
            .prepare('UPDATE index_waiters SET expires_at=? WHERE token=?')
            .run(time + leaseMs, token).changes === 1
        );
      })
      .immediate();
  }

  function cancelForegroundRequest(token: string): void {
    db.prepare('DELETE FROM index_waiters WHERE token=?').run(token);
  }

  function claim(
    requestToken: string,
    mode: IndexOwnerMode,
    stalled?: StalledOwner,
  ): IndexLease | null {
    return db
      .transaction(() => {
        const time = now();
        pruneWaiters(time);
        const waiter = db
          .prepare('SELECT token FROM index_waiters ORDER BY ticket LIMIT 1')
          .get() as { token: string } | undefined;
        if (mode === 'foreground' && waiter?.token !== requestToken) return null;
        if (mode !== 'foreground' && waiter) return null;
        const owner = read();
        const unchangedStall =
          stalled !== undefined &&
          owner.token === stalled.token &&
          owner.heartbeatSequence === stalled.heartbeatSequence;
        if (
          owner.token !== null &&
          owner.expiresAt > time &&
          !unchangedStall &&
          !(mode === 'foreground' && owner.mode === 'background')
        )
          return null;
        // Request tickets may be reused, but a write capability never is.
        const token = randomUUID();
        db.prepare(
          `UPDATE index_owner SET token=?, mode=?, expires_at=?,
        heartbeat_sequence=heartbeat_sequence+1, queued=0, total=0, processed=0, is_running=0
        WHERE id=1`,
        ).run(token, mode, time + leaseMs);
        return { token, mode };
      })
      .immediate();
  }

  function renew(lease: IndexLease, progress?: IndexProgress): boolean {
    return db
      .transaction(() => {
        const time = now();
        const updated = db
          .prepare(
            `UPDATE index_owner SET expires_at=?,
        heartbeat_sequence=heartbeat_sequence+1 WHERE id=1 AND token=? AND expires_at>?`,
          )
          .run(time + leaseMs, lease.token, time).changes;
        if (updated && progress) {
          db.prepare(
            'UPDATE index_owner SET queued=?, total=?, processed=?, is_running=? WHERE id=1',
          ).run(progress.queued, progress.total, progress.processed, progress.isRunning ? 1 : 0);
        }
        return updated === 1;
      })
      .immediate();
  }

  function release(lease: IndexLease): boolean {
    return (
      db
        .prepare(
          `UPDATE index_owner SET token=NULL, mode=NULL, expires_at=0,
      queued=0, total=0, processed=0, is_running=0 WHERE id=1 AND token=?`,
        )
        .run(lease.token).changes === 1
    );
  }

  function write<T>(lease: IndexLease, operation: () => T): T {
    if (operation.constructor.name === 'AsyncFunction') {
      throw new TypeError('Index mutations must be synchronous.');
    }
    const outerToken = fencedTransactionToken;
    if (outerToken !== null && outerToken !== lease.token) {
      throw new IndexLeaseLostError('Nested index mutation has a different owner.');
    }
    return db
      .transaction(() => {
        if (outerToken === null) {
          const owner = read();
          if (owner.token !== lease.token || owner.expiresAt <= now()) {
            throw new IndexLeaseLostError();
          }
        }
        fencedTransactionToken = lease.token;
        try {
          const result = operation();
          if (result && typeof result === 'object' && 'then' in result) {
            throw new TypeError('Index mutations must be synchronous.');
          }
          return result;
        } finally {
          fencedTransactionToken = outerToken;
        }
      })
      .immediate();
  }

  return {
    read,
    requestForeground,
    renewForegroundRequest,
    cancelForegroundRequest,
    claim,
    renew,
    release,
    write,
  };
}
