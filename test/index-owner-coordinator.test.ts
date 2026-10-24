import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
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

it('waits for cancelled native background work before starting local foreground work', async () => {
  const entered = deferred<IndexRunContext>();
  const native = deferred<void>();
  let settled = false;
  let foregroundEntered = false;
  const owner = coordinator(async (run) => {
    entered.resolve(run);
    await native.promise;
    settled = true;
  });
  owner.start();
  const run = await entered.promise;
  const foreground = owner.foreground(() => {
    foregroundEntered = true;
    assert.equal(settled, true);
    return Promise.resolve();
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(run.signal.aborted, true);
    assert.equal(foregroundEntered, false);
  } finally {
    native.resolve();
    await foreground;
  }
});

it.each(['native', 'cleanup'] as const)(
  'wakes local foreground work after %s settles first and both finish',
  async (first) => {
    const entered = deferred<IndexRunContext>();
    const native = deferred<void>();
    const cleanup = deferred<void>();
    let foregroundEntered = false;
    const owner = createIndexCoordinator({
      acquireBackground: async (run) => {
        entered.resolve(run);
        await native.promise;
      },
      releaseBackground: () => cleanup.promise,
      onError: (error) => errors.push(error),
      // The local handoff must not depend on the remote-owner polling interval.
      timing: { heartbeatMs: 10, pollMs: 60_000, waitMs: 120_000 },
    });
    coordinators.push(owner);
    owner.start();
    const run = await entered.promise;
    const foreground = owner.foreground(() => {
      foregroundEntered = true;
      return Promise.resolve();
    });
    void foreground.catch(() => undefined);
    try {
      await nextTurn();
      assert.equal(run.signal.aborted, true);
      assert.equal(foregroundEntered, false);
      (first === 'native' ? native : cleanup).resolve();
      await nextTurn();
      assert.equal(
        foregroundEntered,
        false,
        'the remaining work still owns the local drain barrier',
      );
      (first === 'native' ? cleanup : native).resolve();
      await nextTurn();
      assert.equal(foregroundEntered, true, 'completed local work must wake the queued operation');
      await foreground;
      assert.deepEqual(db.getDb().prepare('SELECT * FROM index_waiters').all(), []);
      assert.deepEqual(errors, []);
    } finally {
      native.resolve();
      cleanup.resolve();
      await owner.close();
      await foreground.catch(() => undefined);
    }
  },
);

it('cancels the local foreground wait immediately while close drains native work and cleanup', async () => {
  const entered = deferred<void>();
  const native = deferred<void>();
  const cleanup = deferred<void>();
  const owner = createIndexCoordinator({
    acquireBackground: async () => {
      entered.resolve();
      await native.promise;
    },
    releaseBackground: () => cleanup.promise,
    onError: (error) => errors.push(error),
    timing: { heartbeatMs: 10, pollMs: 60_000, waitMs: 120_000 },
  });
  coordinators.push(owner);
  owner.start();
  await entered.promise;
  const foreground = owner.foreground(() => Promise.reject(new Error('must not start')));
  let rejected = false;
  const rejection = assert.rejects(foreground, /closed|abort/i).then(() => {
    rejected = true;
  });
  void rejection.catch(() => undefined);
  let closed = false;
  const closing = owner.close().then(() => {
    closed = true;
  });
  try {
    await nextTurn();
    assert.equal(rejected, true);
    assert.equal(closed, false);
    assert.deepEqual(db.getDb().prepare('SELECT * FROM index_waiters').all(), []);
  } finally {
    native.resolve();
    cleanup.resolve();
    await Promise.all([closing, rejection]);
  }
  assert.deepEqual(errors, []);
});

it('wakes the next local foreground caller when the current operation finishes', async () => {
  const entered = deferred<void>();
  const native = deferred<void>();
  let secondEntered = false;
  const owner = createIndexCoordinator({
    acquireBackground: async () => {},
    releaseBackground: async () => {},
    onError: (error) => errors.push(error),
    timing: { heartbeatMs: 10, pollMs: 60_000, waitMs: 120_000 },
  });
  coordinators.push(owner);
  const first = owner.foreground(async () => {
    entered.resolve();
    await native.promise;
  });
  await entered.promise;
  const second = owner.foreground(() => {
    secondEntered = true;
    return Promise.resolve();
  });
  void second.catch(() => undefined);
  try {
    await nextTurn();
    assert.equal(secondEntered, false);
    native.resolve();
    await nextTurn();
    assert.equal(secondEntered, true, 'the next local caller must not wait for a polling tick');
    await Promise.all([first, second]);
    assert.deepEqual(db.getDb().prepare('SELECT * FROM index_waiters').all(), []);
    assert.deepEqual(errors, []);
  } finally {
    native.resolve();
    await owner.close();
    await Promise.allSettled([first, second]);
  }
});

it('keeps close pending until its aborted background callback settles', async () => {
  const entered = deferred<void>();
  const native = deferred<void>();
  const owner = coordinator(async () => {
    entered.resolve();
    await native.promise;
  });
  owner.start();
  await entered.promise;
  let closed = false;
  const closing = owner.close().then(() => {
    closed = true;
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(closed, false);
  } finally {
    native.resolve();
    await closing;
  }
});

it('counts local queue time toward the deadline and registers its global ticket immediately', async () => {
  const entered = deferred<void>();
  const native = deferred<void>();
  const owner = coordinator();
  const first = owner.foreground(async () => {
    entered.resolve();
    await native.promise;
  });
  await entered.promise;
  const second = owner.foreground(() => Promise.reject(new Error('must not enter')));
  const rejected = assert.rejects(second, /timed out.*indexing/i);
  let timedOut = false;
  void rejected.then(() => {
    timedOut = true;
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(db.getDb().prepare('SELECT count(*) FROM index_waiters').pluck().get(), 1);
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(timedOut, true);
    assert.deepEqual(db.getDb().prepare('SELECT * FROM index_waiters').all(), []);
  } finally {
    native.resolve();
    await first;
    await rejected;
  }
});

it('does not let an aborted foreground response release its actual native work barrier', async () => {
  const entered = deferred<IndexRunContext>();
  const native = deferred<void>();
  const owner = coordinator();
  const first = owner.foreground(async (run) => {
    entered.resolve(run);
    await native.promise;
  });
  const rejected = assert.rejects(first, /ownership/i);
  const run = await entered.promise;
  db.releaseIndexLease(run.lease);
  await rejected;
  let secondEntered = false;
  const second = owner.foreground(() => {
    secondEntered = true;
    return Promise.resolve();
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(secondEntered, false);
  } finally {
    native.resolve();
    await second;
  }
});
