import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, it } from 'vitest';
import type { IndexRunContext } from '../src/indexing/index-owner.js';

const vault = mkdtempSync(path.join(tmpdir(), 'ohs-coordinator-'));
process.env.OBSIDIAN_VAULT_PATH = vault;
const db = await import('../src/storage/db.js');
const { createIndexCoordinator } = await import('../src/indexing/index-owner.js');
const coordinators: ReturnType<typeof createIndexCoordinator>[] = [];
let errors: unknown[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function coordinator(acquireBackground: (run: IndexRunContext) => Promise<void> = async () => {}) {
  const instance = createIndexCoordinator({
    acquireBackground,
    releaseBackground: async () => {},
    onError: (error) => errors.push(error),
    timing: { heartbeatMs: 10, pollMs: 10, waitMs: 150 },
  });
  coordinators.push(instance);
  return instance;
}

beforeEach(() => {
  db.openDb();
  errors = [];
});
afterEach(async () => {
  await Promise.all(coordinators.splice(0).map((owner) => owner.close()));
  db.closeDb();
});

it('hands a live background owner to a foreground caller without awaiting stale inference', async () => {
  const entered = deferred<IndexRunContext>();
  const inference = deferred<void>();
  const settled = deferred<void>();
  const background = coordinator(async (run) => {
    entered.resolve(run);
    try {
      await inference.promise;
      run.signal.throwIfAborted();
      db.updateLastIndexed(run.lease);
    } finally {
      settled.resolve();
    }
  });
  background.start();
  const stale = await entered.promise;
  const foreground = coordinator();
  await foreground.foreground((run) => {
    db.withIndexMutation(run.lease, () => {
      db.getDb()
        .prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('evidence','foreground')")
        .run();
    });
    return Promise.resolve();
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(stale.signal.aborted, true);
  inference.resolve();
  await settled.promise;
  assert.equal(
    db.getDb().prepare("SELECT value FROM settings WHERE key='last_indexed'").get(),
    undefined,
  );
  assert.deepEqual(db.getDb().prepare("SELECT value FROM settings WHERE key='evidence'").get(), {
    value: 'foreground',
  });
  assert.deepEqual(errors, []);
});

it('does no background work in a live owner follower', async () => {
  const entered = deferred<void>();
  const leader = coordinator(() => {
    entered.resolve();
    return Promise.resolve();
  });
  leader.start();
  await entered.promise;
  let followerCalls = 0;
  const follower = coordinator(() => {
    followerCalls++;
    return Promise.resolve();
  });
  follower.start();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(followerCalls, 0);
  assert.deepEqual(errors, []);
});

it('serializes foreground work and removes completed waiter tickets', async () => {
  const firstEntered = deferred<void>();
  const finishFirst = deferred<void>();
  const order: string[] = [];
  const first = coordinator();
  const second = coordinator();
  const a = first.foreground(async () => {
    order.push('first');
    firstEntered.resolve();
    await finishFirst.promise;
  });
  await firstEntered.promise;
  const b = second.foreground(() => {
    order.push('second');
    return Promise.resolve();
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(order, ['first']);
  finishFirst.resolve();
  await Promise.all([a, b]);
  assert.deepEqual(order, ['first', 'second']);
  assert.deepEqual(db.getDb().prepare('SELECT * FROM index_waiters').all(), []);
});

it('times out a waiting foreground operation and removes its ticket', async () => {
  db.requestForegroundIndex('held');
  const held = db.claimIndexLease('held', 'foreground');
  assert.ok(held);
  db.cancelForegroundIndexRequest('held');
  try {
    await assert.rejects(
      coordinator().foreground(() => Promise.reject(new Error('must not run'))),
      /timed out.*indexing/i,
    );
    assert.deepEqual(db.getDb().prepare('SELECT * FROM index_waiters').all(), []);
  } finally {
    db.releaseIndexLease(held);
  }
});

it('closing aborts a queued foreground operation without leaving a ticket', async () => {
  db.requestForegroundIndex('held');
  const held = db.claimIndexLease('held', 'foreground');
  assert.ok(held);
  db.cancelForegroundIndexRequest('held');
  const waiting = coordinator();
  const request = waiting.foreground(() => Promise.reject(new Error('must not run')));
  const rejected = assert.rejects(request, /closed|abort/i);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await waiting.close();
  await rejected;
  db.releaseIndexLease(held);
  assert.deepEqual(db.getDb().prepare('SELECT * FROM index_waiters').all(), []);
});

afterAll(() => rmSync(vault, { recursive: true, force: true }));
