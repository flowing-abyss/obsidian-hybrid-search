import assert from 'node:assert/strict';
import { AsyncLocalStorage, createHook } from 'node:async_hooks';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';

const barrier = process.argv[2];
assert.ok(barrier === 'background' || barrier === 'cleanup' || barrier === 'foreground');
const collect = global.gc;
assert.ok(collect, 'the retention fixture requires --expose-gc');
const vault = mkdtempSync(path.join(tmpdir(), 'ohs-owner-retention-'));
process.env.OBSIDIAN_VAULT_PATH = vault;
const db = await import('../../src/storage/db.js');
const { createIndexCoordinator } = await import('../../src/indexing/index-owner.js');

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Observe the real promises without retaining their resources or putting any
// references to them in the async context that the coordinator inherits.
const requestContext = new AsyncLocalStorage<number>();
const sampled: WeakRef<object>[] = [];
const hook = createHook({
  init(_id, type, _trigger, resource: object) {
    if (type === 'PROMISE' && requestContext.getStore() !== undefined)
      sampled.push(new WeakRef(resource));
  },
});

async function retainedPromises(): Promise<number> {
  // WeakRef creation and deref keep a target alive through the current job.
  // Cross turns before every forced collection and before sampling again.
  for (let iteration = 0; iteration < 4; iteration++) {
    await nextTurn();
    collect!();
  }
  return sampled.filter((reference) => reference.deref() !== undefined).length;
}

const entered = deferred();
const held = deferred();
const errors: unknown[] = [];
const owner = createIndexCoordinator({
  acquireBackground() {
    entered.resolve();
    return barrier === 'background' ? held.promise : Promise.resolve();
  },
  releaseBackground: () => (barrier === 'cleanup' ? held.promise : Promise.resolve()),
  onError: (error) => errors.push(error),
  timing: { heartbeatMs: 10, pollMs: 5, waitMs: 30 },
});

async function timeOutBatch(batch: number): Promise<void> {
  for (let request = 0; request < 6; request++) {
    await assert.rejects(
      requestContext.run(batch, () =>
        owner.foreground(() => Promise.reject(new Error('must not enter while work is held'))),
      ),
      /timed out.*indexing/i,
    );
  }
  assert.deepEqual(db.getDb().prepare('SELECT * FROM index_waiters').all(), []);
}

async function closeWithQueuedRequest(): Promise<void> {
  const queued = requestContext.run(3, () =>
    owner.foreground(() => Promise.reject(new Error('must not enter during close'))),
  );
  const rejected = assert.rejects(queued, /closed|abort/i);
  void owner.close();
  await rejected;
  assert.deepEqual(db.getDb().prepare('SELECT * FROM index_waiters').all(), []);
}

// Coordinator timers are deliberately unref'd. Keep this isolated child alive
// until it has released the native barrier and closed its real database.
const keepAlive = setInterval(() => {}, 1_000);
let foreground: Promise<unknown> | undefined;
let closed = false;
try {
  db.openDb();
  if (barrier === 'foreground') {
    foreground = owner.foreground(() => {
      entered.resolve();
      return held.promise;
    });
    void foreground.catch(() => undefined);
  } else owner.start();
  await entered.promise;
  await nextTurn();
  hook.enable();
  await timeOutBatch(1);
  const afterFirstBatch = await retainedPromises();
  await timeOutBatch(2);
  const afterSecondBatch = await retainedPromises();
  await closeWithQueuedRequest();
  const closing = owner.close().then(() => {
    closed = true;
  });
  const afterClose = await retainedPromises();
  assert.equal(closed, false, 'close must still drain the held operation');
  held.resolve();
  await closing;
  await foreground?.catch(() => undefined);
  const afterRelease = await retainedPromises();
  assert.deepEqual(errors, []);
  process.stdout.write(
    JSON.stringify({
      sampled: sampled.length,
      afterFirstBatch,
      afterSecondBatch,
      afterClose,
      afterRelease,
    }),
  );
} finally {
  held.resolve();
  await owner.close();
  await foreground?.catch(() => undefined);
  hook.disable();
  requestContext.disable();
  db.closeDb();
  clearInterval(keepAlive);
  rmSync(vault, { recursive: true, force: true });
}
