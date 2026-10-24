import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { config } from '../../src/runtime/config.js';
import * as storage from '../../src/storage/db.js';
import type { IndexLease } from '../../src/storage/index-ownership.js';

export * from '../../src/storage/db.js';

let active: { lease: IndexLease; users: number } | undefined;

function enter(): IndexLease {
  if (active) {
    active.users++;
    return active.lease;
  }
  const request = randomUUID();
  storage.requestForegroundIndex(request);
  try {
    const lease = storage.claimIndexLease(request, 'foreground');
    if (!lease) throw new Error('Test fixture cannot acquire index ownership');
    active = { lease, users: 1 };
    return lease;
  } finally {
    storage.cancelForegroundIndexRequest(request);
  }
}

function leave(): void {
  if (!active || --active.users > 0) return;
  const { lease } = active;
  active = undefined;
  storage.releaseIndexLease(lease);
}

export function withTestIndexLease<T>(operation: (lease: IndexLease) => T): T {
  const lease = enter();
  try {
    return operation(lease);
  } finally {
    leave();
  }
}

export async function withTestIndexRun<T>(
  operation: (run: { lease: IndexLease; signal: AbortSignal }) => Promise<T>,
): Promise<T> {
  const lease = enter();
  const controller = new AbortController();
  const heartbeat = setInterval(() => storage.renewIndexLease(lease), 5_000);
  heartbeat.unref();
  try {
    return await operation({ lease, signal: controller.signal });
  } finally {
    clearInterval(heartbeat);
    controller.abort();
    leave();
  }
}

function owned<Args extends unknown[], Result>(
  operation: (lease: IndexLease, ...args: Args) => Result,
) {
  return (...args: Args): Result => withTestIndexLease((lease) => operation(lease, ...args));
}

export const initVecTable = owned(storage.initVecTable);
export const upsertNote = owned(storage.upsertNote);
export const deleteNote = owned(storage.deleteNote);
export const upsertLinks = owned(storage.upsertLinks);
export const upsertMarkdownLinks = owned(storage.upsertMarkdownLinks);
export const upsertNoteUrls = owned(storage.upsertNoteUrls);
export const saveConfigMeta = owned(storage.saveConfigMeta);
export const updateLastIndexed = owned(storage.updateLastIndexed);
export const cleanupIgnoredNotes = owned(storage.cleanupIgnoredNotes);

/** Only isolated test fixtures may remove a database after closing its handles. */
export function wipeDatabaseFiles(): void {
  if (active) throw new Error('Close the fixture indexing operation before resetting its database');
  storage.closeDb();
  for (const suffix of ['', '-wal', '-shm']) rmSync(config.dbPath + suffix, { force: true });
}
