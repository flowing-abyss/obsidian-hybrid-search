import Database from 'better-sqlite3';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, it } from 'vitest';
import { createIndexOwnership, IndexLeaseLostError } from '../src/storage/index-ownership.js';

let directory: string;
let first: Database.Database;
let second: Database.Database;
let now: number;
let a: ReturnType<typeof createIndexOwnership>;
let b: ReturnType<typeof createIndexOwnership>;

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'ohs-owner-'));
  first = new Database(path.join(directory, 'index.db'));
  first.pragma('journal_mode = WAL');
  first.exec('CREATE TABLE evidence(value TEXT)');
  second = new Database(path.join(directory, 'index.db'));
  now = 1_000_000;
  a = createIndexOwnership(first, { now: () => now, leaseMs: 100 });
  b = createIndexOwnership(second, { now: () => now, leaseMs: 100 });
});

afterEach(() => {
  second?.close();
  first?.close();
  rmSync(directory, { recursive: true, force: true });
});

it('rejects the previous writer after another connection takes ownership', () => {
  const old = a.claim('old', 'background');
  assert.ok(old);
  assert.equal(b.claim('other', 'background'), null);
  now += 101;
  const current = b.claim('new', 'background');
  assert.ok(current);
  assert.throws(
    () =>
      a.write(old, () => {
        first.prepare('INSERT INTO evidence VALUES (?)').run('stale');
      }),
    IndexLeaseLostError,
  );
  assert.equal(a.renew(old), false);
  assert.equal(a.release(old), false);
  b.write(current, () => second.prepare('INSERT INTO evidence VALUES (?)').run('current'));
  assert.deepEqual(first.prepare('SELECT value FROM evidence').all(), [{ value: 'current' }]);
});

it('does not revive a capability when the acquisition request token is reused', () => {
  const old = a.claim('same-request', 'background');
  assert.ok(old);
  assert.equal(a.release(old), true);
  const current = a.claim('same-request', 'background');
  assert.ok(current);
  assert.notEqual(current.token, old.token);
  assert.throws(
    () => a.write(old, () => first.exec("INSERT INTO evidence VALUES('stale')")),
    IndexLeaseLostError,
  );
});

it('rejects expiry even when no successor has claimed the database', () => {
  const lease = a.claim('old', 'background');
  assert.ok(lease);
  now += 101;
  assert.equal(a.renew(lease), false);
  assert.throws(
    () => a.write(lease, () => first.exec("INSERT INTO evidence VALUES('expired')")),
    IndexLeaseLostError,
  );
  assert.deepEqual(first.prepare('SELECT * FROM evidence').all(), []);
});

it('rolls back every nested mutation when the outer operation fails', () => {
  const lease = a.claim('writer', 'background');
  assert.ok(lease);
  assert.throws(
    () =>
      a.write(lease, () => {
        first.exec("INSERT INTO evidence VALUES('first')");
        a.write(lease, () => first.exec("INSERT INTO evidence VALUES('second')"));
        throw new Error('injected failure');
      }),
    /injected failure/,
  );
  assert.deepEqual(second.prepare('SELECT * FROM evidence').all(), []);
  a.write(lease, () => first.exec("INSERT INTO evidence VALUES('retry')"));
  assert.deepEqual(second.prepare('SELECT * FROM evidence').all(), [{ value: 'retry' }]);
});

it('does not expire a large atomic publication while its write lock is held', () => {
  const lease = a.claim('writer', 'background');
  assert.ok(lease);
  const initial = a.read();
  a.write(lease, () => {
    first.exec("INSERT INTO evidence VALUES('first')");
    now += 101;
    a.write(lease, () => first.exec("INSERT INTO evidence VALUES('second')"));
    assert.equal(a.read().expiresAt, initial.expiresAt, 'nested helpers must not renew');
  });
  assert.deepEqual(second.prepare('SELECT * FROM evidence').all(), [
    { value: 'first' },
    { value: 'second' },
  ]);
  assert.equal(a.read().expiresAt, now + 100);
  assert.equal(a.read().heartbeatSequence, initial.heartbeatSequence + 1);
  a.write(lease, () => first.exec("INSERT INTO evidence VALUES('next batch')"));
});

it('does not renew short writes or persist renewal from a rolled-back long transaction', () => {
  const lease = a.claim('writer', 'background');
  assert.ok(lease);
  const initial = a.read();
  a.write(lease, () => first.exec("INSERT INTO evidence VALUES('short')"));
  assert.deepEqual(a.read(), initial);
  assert.throws(
    () =>
      a.write(lease, () => {
        now += 101;
        first.exec("INSERT INTO evidence VALUES('rolled back')");
        throw new Error('late failure');
      }),
    /late failure/,
  );
  assert.deepEqual(a.read(), initial);
  assert.deepEqual(first.prepare('SELECT value FROM evidence').all(), [{ value: 'short' }]);
  assert.ok(b.claim('successor', 'background'));
  assert.throws(() => a.write(lease, () => undefined), IndexLeaseLostError);
});

it('rejects asynchronous transaction callbacks before they start writing', () => {
  const lease = a.claim('writer', 'background');
  assert.ok(lease);
  let started = false;
  assert.throws(
    () =>
      a.write(lease, async () => {
        started = true;
        await Promise.resolve();
        first.exec("INSERT INTO evidence VALUES('unsafe')");
      }),
    /synchronous/,
  );
  assert.equal(started, false);
  assert.throws(
    () =>
      a.write(lease, () => {
        first.exec("INSERT INTO evidence VALUES('rollback')");
        return Promise.resolve();
      }),
    /synchronous/,
  );
  assert.deepEqual(second.prepare('SELECT * FROM evidence').all(), []);
});

it('gives only the first foreground waiter priority over a live background owner', () => {
  const background = a.claim('background', 'background');
  assert.ok(background);
  a.requestForeground('first');
  b.requestForeground('second');
  assert.equal(b.claim('second', 'foreground'), null);
  const foreground = b.claim('first', 'foreground');
  assert.ok(foreground);
  assert.throws(
    () => a.write(background, () => first.exec("INSERT INTO evidence VALUES('old')")),
    IndexLeaseLostError,
  );
  b.cancelForegroundRequest('first');
  assert.equal(a.claim('second', 'foreground'), null);
  assert.equal(b.release(foreground), true);
  assert.equal(a.claim('another-background', 'background'), null);
  const next = a.claim('second', 'foreground');
  assert.ok(next);
  a.write(next, () => first.exec("INSERT INTO evidence VALUES('next')"));
  assert.deepEqual(second.prepare('SELECT * FROM evidence').all(), [{ value: 'next' }]);
});

it('expires dead waiters and refuses to renew their abandoned tickets', () => {
  a.requestForeground('dead');
  now += 101;
  assert.equal(a.renewForegroundRequest('dead'), false);
  const lease = b.claim('background', 'background');
  assert.ok(lease);
  assert.equal(a.claim('dead', 'foreground'), null);
});

it('bounds dead tickets after a backwards wall clock jump', () => {
  a.requestForeground('dead');
  now -= 10_000;
  assert.ok(b.claim('background', 'background'));
});

it('does not take over a stalled observation after the owner has renewed', () => {
  const current = a.claim('current', 'background');
  assert.ok(current);
  const observed = a.read();
  assert.equal(a.renew(current), true);
  now -= 10_000;
  assert.equal(
    b.claim('next', 'background', {
      token: current.token,
      heartbeatSequence: observed.heartbeatSequence,
    }),
    null,
  );
  const latest = a.read();
  const next = b.claim('next', 'background', {
    token: current.token,
    heartbeatSequence: latest.heartbeatSequence,
  });
  assert.ok(next);
  assert.throws(
    () => a.write(current, () => first.exec("INSERT INTO evidence VALUES('stale')")),
    IndexLeaseLostError,
  );
});

it('shares progress with readers without allowing a stale owner to overwrite it', () => {
  const current = a.claim('current', 'background');
  assert.ok(current);
  assert.equal(a.renew(current, { queued: 3, total: 10, processed: 7, isRunning: true }), true);
  assert.equal(b.read().processed, 7);
  a.requestForeground('foreground');
  const next = b.claim('foreground', 'foreground');
  assert.ok(next);
  assert.equal(a.renew(current, { queued: 10, total: 10, processed: 0, isRunning: true }), false);
  assert.equal(a.read().queued, 0);
});
