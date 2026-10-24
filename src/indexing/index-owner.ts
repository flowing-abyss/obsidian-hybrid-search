import { randomInt, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import {
  cancelForegroundIndexRequest,
  claimIndexLease,
  readIndexOwner,
  releaseIndexLease,
  renewForegroundIndexRequest,
  renewIndexLease,
  requestForegroundIndex,
} from '../storage/db.js';
import {
  INDEX_LEASE_MS,
  IndexLeaseLostError,
  type IndexLease,
  type IndexOwnerSnapshot,
  type StalledOwner,
} from '../storage/index-ownership.js';

export interface IndexRunContext {
  lease: IndexLease;
  signal: AbortSignal;
}
export interface IndexCoordinator {
  start(): void;
  foreground<T>(work: (run: IndexRunContext) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

interface OwnedRun {
  run: IndexRunContext;
  controller: AbortController;
  background: boolean;
}

function isBusy(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED')
  );
}

/** Cancel the caller's wait; a native operation may still settle, but cannot write. */
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(signal.reason instanceof Error ? signal.reason : new Error('Indexing aborted'));
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

export function createIndexCoordinator(options: {
  acquireBackground(run: IndexRunContext): Promise<void>;
  releaseBackground(): Promise<void>;
  onError(error: unknown): void;
  timing?: { heartbeatMs: number; pollMs: number; waitMs: number };
}): IndexCoordinator {
  const heartbeatMs = options.timing?.heartbeatMs ?? 5_000;
  const pollMs = options.timing?.pollMs ?? 5_000;
  const foregroundPollMs = options.timing?.pollMs ?? 250;
  const waitMs = options.timing?.waitMs ?? 120_000;
  const lifetime = new AbortController();
  let backgroundEnabled = false;
  let owned: OwnedRun | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let backgroundWork: Promise<void> | undefined;
  let backgroundCleanup: Promise<void> | undefined;
  let foregroundTail: Promise<unknown> = Promise.resolve();
  let pendingForeground = 0;
  let observation: { token: string | null; sequence: number; since: number } | undefined;
  let reportedBusy = false;

  function report(error: unknown): void {
    options.onError(error);
  }

  function observe(snapshot: IndexOwnerSnapshot): StalledOwner | undefined {
    if (
      !observation ||
      observation.token !== snapshot.token ||
      observation.sequence !== snapshot.heartbeatSequence
    ) {
      observation = {
        token: snapshot.token,
        sequence: snapshot.heartbeatSequence,
        since: performance.now(),
      };
    }
    return snapshot.token && performance.now() - observation.since >= INDEX_LEASE_MS
      ? { token: snapshot.token, heartbeatSequence: snapshot.heartbeatSequence }
      : undefined;
  }

  function schedule(immediate = false): void {
    if (timer || lifetime.signal.aborted || (!owned && !backgroundEnabled)) return;
    const jitter = options.timing ? 0 : randomInt(1_000);
    timer = setTimeout(tick, immediate ? 0 : owned ? heartbeatMs : pollMs + jitter);
    timer.unref();
  }

  function stopOwned(reason = new IndexLeaseLostError()): Promise<void> {
    const previous = owned;
    if (!previous) return backgroundCleanup ?? Promise.resolve();
    owned = undefined;
    previous.controller.abort(reason);
    try {
      releaseIndexLease(previous.run.lease);
    } catch (error) {
      report(error);
    }
    if (previous.background) {
      const cleanup = Promise.resolve()
        .then(() => options.releaseBackground())
        .catch(report)
        .finally(() => {
          if (backgroundCleanup === cleanup) backgroundCleanup = undefined;
          schedule();
        });
      backgroundCleanup = cleanup;
      return cleanup;
    }
    return Promise.resolve();
  }

  function beginBackground(lease: IndexLease): void {
    const controller = new AbortController();
    const run = { lease, signal: controller.signal };
    owned = { run, controller, background: true };
    const work = Promise.resolve()
      .then(() => options.acquireBackground(run))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof IndexLeaseLostError) {
          if (owned?.run === run) void stopOwned(error);
          return;
        }
        // A permanent initialization failure is visible and must not spin through owners.
        backgroundEnabled = false;
        report(error);
        if (owned?.run === run)
          void stopOwned(error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => {
        if (backgroundWork === work) backgroundWork = undefined;
        schedule();
      });
    backgroundWork = work;
  }

  function tick(): void {
    timer = undefined;
    if (lifetime.signal.aborted) return;
    try {
      if (owned) {
        if (!renewIndexLease(owned.run.lease)) void stopOwned();
      } else if (
        backgroundEnabled &&
        pendingForeground === 0 &&
        !backgroundWork &&
        !backgroundCleanup
      ) {
        const snapshot = readIndexOwner();
        const stalled = observe(snapshot);
        if (!snapshot.token || snapshot.expiresAt <= Date.now() || stalled) {
          const lease = claimIndexLease(randomUUID(), 'background', stalled);
          if (lease) beginBackground(lease);
        }
      }
      reportedBusy = false;
    } catch (error) {
      if (!isBusy(error)) {
        backgroundEnabled = false;
        report(error);
        if (owned) void stopOwned(error instanceof Error ? error : new Error(String(error)));
      } else if (!reportedBusy) {
        reportedBusy = true;
        report(error);
      }
    } finally {
      schedule();
    }
  }

  async function runForeground<T>(work: (run: IndexRunContext) => Promise<T>): Promise<T> {
    lifetime.signal.throwIfAborted();
    const request = randomUUID();
    const deadline = performance.now() + waitMs;
    let ticketRegistered = false;
    let ticketRenewal = 0;
    let failures = 0;
    let current: OwnedRun | undefined;
    try {
      for (;;) {
        lifetime.signal.throwIfAborted();
        if (performance.now() >= deadline)
          throw new Error(
            'Timed out waiting for indexing ownership. Another reindex is still running.',
          );
        try {
          if (!ticketRegistered) {
            requestForegroundIndex(request);
            ticketRegistered = true;
            ticketRenewal = performance.now();
          } else if (performance.now() - ticketRenewal >= heartbeatMs) {
            if (!renewForegroundIndexRequest(request)) requestForegroundIndex(request);
            ticketRenewal = performance.now();
          }
          if (owned?.background) void stopOwned();
          const snapshot = readIndexOwner();
          const lease = claimIndexLease(request, 'foreground', observe(snapshot));
          if (lease) {
            const controller = new AbortController();
            current = { run: { lease, signal: controller.signal }, controller, background: false };
            owned = current;
            cancelForegroundIndexRequest(request);
            ticketRegistered = false;
            schedule(true);
            break;
          }
          failures = 0;
        } catch (error) {
          if (!isBusy(error) || failures >= 3) throw error;
          await delay([50, 150, 450][failures++], undefined, { signal: lifetime.signal });
          continue;
        }
        await delay(foregroundPollMs, undefined, { signal: lifetime.signal });
      }
      const run = current.run;
      return await abortable(
        Promise.resolve().then(() => work(run)),
        run.signal,
      );
    } finally {
      if (ticketRegistered) {
        try {
          cancelForegroundIndexRequest(request);
        } catch (error) {
          report(error);
        }
      }
      if (current && owned === current) await stopOwned();
      schedule();
    }
  }

  return {
    start() {
      if (lifetime.signal.aborted) throw new Error('Indexing service is closed');
      backgroundEnabled = true;
      schedule(true);
    },
    foreground<T>(work: (run: IndexRunContext) => Promise<T>): Promise<T> {
      pendingForeground++;
      const task = foregroundTail.then(() => runForeground(work));
      foregroundTail = task.catch(() => undefined);
      return task.finally(() => {
        pendingForeground--;
        schedule();
      });
    },
    async close() {
      if (lifetime.signal.aborted) return;
      lifetime.abort(new Error('Indexing service is closed'));
      backgroundEnabled = false;
      clearTimeout(timer);
      timer = undefined;
      await stopOwned(new Error('Indexing service is closed'));
      await foregroundTail;
    },
  };
}
