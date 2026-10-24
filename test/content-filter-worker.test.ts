import { ChildProcess } from 'node:child_process';
import { getEventListeners } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseContentIgnorePatterns } from '../src/content/content-ignore.js';
import { createContentFilter } from '../src/indexing/content-filter.js';

const workerUrl = new URL('./fixtures/content-filter-worker.ts', import.meta.url);
const clients: ReturnType<typeof createContentFilter>[] = [];
let directory: string;
let pidFile: string;
let messageFile: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ohs-content-filter-'));
  pidFile = path.join(directory, 'workers');
  messageFile = path.join(directory, 'messages');
  vi.stubEnv('OHS_CONTENT_FILTER_PID_FILE', pidFile);
  vi.stubEnv('OHS_CONTENT_FILTER_MESSAGE_FILE', messageFile);
  vi.stubEnv('OHS_CONTENT_FILTER_MODE', 'healthy');
});

function workers(): Array<{ pid: number; heapLimit: number }> {
  if (!fs.existsSync(pidFile)) return [];
  return fs
    .readFileSync(pidFile, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { pid: number; heapLimit: number });
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const { pid } of workers()) {
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  }
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

function client(pattern = '/secret/g', options: Parameters<typeof createContentFilter>[1] = {}) {
  const filter = createContentFilter(parseContentIgnorePatterns(pattern), {
    workerUrl,
    ...options,
  });
  clients.push(filter);
  return filter;
}

async function dispatched(): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(messageFile) || !fs.readFileSync(messageFile, 'utf8').includes('project')) {
    if (Date.now() > deadline) throw new Error('Fixture did not receive projection');
    await delay(10);
  }
}

describe('bounded content filtering', () => {
  it('keeps the empty policy on the main process without starting a child', async () => {
    const filter = client('');
    expect(
      await filter.project('Original %%knowledge%%', { signal: new AbortController().signal }),
    ).toEqual({ text: 'Original %%knowledge%%', segments: null });
    expect(workers()).toEqual([]);
  });

  it('canonicalizes signatures without ignoring changed rules', () => {
    const first = client('/secret/gi,/private/g');
    const equivalent = client(' /private/g, /secret/ig, /private/g ');
    expect(first.signature).toBe(equivalent.signature);
    expect(first.signature).not.toBe(client('/changed/g').signature);
    expect(first.signature).not.toBe(client('').signature);
    expect(workers()).toEqual([]);
  });

  it('reuses one bounded child and preserves job results in a concurrent batch', async () => {
    const filter = client();
    const signal = new AbortController().signal;
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        filter.project(`${index} secret visible`, { signal }),
      ),
    );
    expect(results.map((result) => result.text)).toEqual(
      Array.from({ length: 10 }, (_, index) => `${index}   visible`),
    );
    expect((await filter.project('secret remaining', { signal })).text).toBe(' remaining');
    expect(workers()).toHaveLength(1);
    expect(workers()[0]!.heapLimit).toBeLessThan(400 * 1024 * 1024);
  });

  it.each([
    '--max-old-space-size=1024 --max-semi-space-size=64',
    '--max-old-space-size-percentage=50',
    '--max_old_space_size_percentage "50"',
    '--max_old_space_size_percentage "" "50"',
    '--max-old-space-size-percentage=0x1.9p+5',
    '--max_old_space_size_percentage 0x1.9p+5',
    '--max-old-space-size-percentage=nan',
    '--max_old_space_size_percentage nan(payload)',
    '"--max_heap_size=1024"',
  ])('bounds the real child heap with inherited %s', async (options) => {
    vi.stubEnv('NODE_OPTIONS', options);
    const filter = client();
    expect(
      (await filter.project('secret remaining', { signal: new AbortController().signal })).text,
    ).toBe(' remaining');
    expect(workers()).toHaveLength(1);
    expect(workers()[0]!.heapLimit).toBeLessThan(400 * 1024 * 1024);
    expect(process.env.NODE_OPTIONS).toBe(options);
  });

  it('preserves quoted preloads and unrelated runtime options while bounding the heap', async () => {
    const preload = path.join(directory, 'preload --max-old-space-size=4096 fixture.cjs');
    const marker = path.join(directory, 'preloaded');
    fs.writeFileSync(
      preload,
      `let disabled = false;
      try { ({}).__proto__; } catch (error) { disabled = error.code === 'ERR_PROTO_ACCESS'; }
      require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ disabled }));`,
    );
    const options = `--max-heap-size=1024 --require ${JSON.stringify(preload)} --disable-proto=throw --max_old_space_size_percentage "50"`;
    vi.stubEnv('NODE_OPTIONS', options);
    expect(
      (await client().project('secret remaining', { signal: new AbortController().signal })).text,
    ).toBe(' remaining');
    expect(JSON.parse(fs.readFileSync(marker, 'utf8'))).toEqual({ disabled: true });
    expect(workers()[0]!.heapLimit).toBeLessThan(400 * 1024 * 1024);
    expect(process.env.NODE_OPTIONS).toBe(options);
  });

  it('preserves inherited filesystem permission restrictions', async () => {
    const preload = path.join(directory, 'permission probe.cjs');
    const marker = path.join(directory, 'permission-result');
    fs.writeFileSync(
      preload,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
        allowed: process.permission.has('fs.write', ${JSON.stringify(marker)}),
        denied: process.permission.has('fs.write', ${JSON.stringify(path.join(os.tmpdir(), 'ohs-outside-worker-permission'))})
      }));`,
    );
    vi.stubEnv(
      'NODE_OPTIONS',
      `--max-semi-space-size=64 --permission --allow-fs-read=* --allow-fs-write=${JSON.stringify(directory)} --allow-worker --require ${JSON.stringify(preload)}`,
    );
    expect(
      (await client().project('secret remaining', { signal: new AbortController().signal })).text,
    ).toBe(' remaining');
    expect(JSON.parse(fs.readFileSync(marker, 'utf8'))).toEqual({ allowed: true, denied: false });
    expect(workers()[0]!.heapLimit).toBeLessThan(400 * 1024 * 1024);
  });

  it.each([
    '--max-old-space-size-percentage=',
    '--max-old-space-size-percentage',
    '--max-old-space-size-percentage --not-a-node-option',
    '--permission --allow-fs-read=* --allow-worker --allow-fs-write --max-heap-size=1024 *',
    '--max-semi-space-size=64 --not-a-node-option',
    '--max-semi-space-size=64 --require "unterminated',
    '--max-semi-space-size=64 --require "invalid-escape\\',
  ])('keeps malformed inherited options observable for %s', async (options) => {
    vi.stubEnv('NODE_OPTIONS', options);
    await expect(
      client().project('secret remaining', { signal: new AbortController().signal }),
    ).rejects.toMatchObject({ name: 'ContentFilterError', scope: 'worker' });
    expect(workers()).toEqual([]);
    expect(process.env.NODE_OPTIONS).toBe(options);
  });

  it.each([false, true])(
    'shares one owner listener across a full worker batch with cancel=%s',
    async (cancel) => {
      const filter = client();
      const owner = new AbortController();
      const unrelated = [vi.fn(), vi.fn()];
      for (const listener of unrelated) owner.signal.addEventListener('abort', listener);
      const baseline = getEventListeners(owner.signal, 'abort').length;
      const pending = Promise.allSettled(
        Array.from({ length: 10 }, (_, index) =>
          filter.project(`${index} secret visible`, { signal: owner.signal }),
        ),
      );
      try {
        expect(getEventListeners(owner.signal, 'abort')).toHaveLength(baseline + 1);
        if (cancel) owner.abort(new Error('Owner left'));
        const results = await pending;
        expect(
          results.every((result) => result.status === (cancel ? 'rejected' : 'fulfilled')),
        ).toBe(true);
        expect(getEventListeners(owner.signal, 'abort')).toHaveLength(baseline);
        if (!cancel) owner.abort();
        for (const listener of unrelated) expect(listener).toHaveBeenCalledOnce();
      } finally {
        await filter.close();
        await pending;
      }
    },
  );

  it('times out a real catastrophic expression while the parent remains responsive', async () => {
    const filter = client('/(a+)+$/', { jobTimeoutMs: 100 });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    try {
      await expect(
        filter.project('a'.repeat(32_000) + '!', { signal: new AbortController().signal }),
      ).rejects.toThrow(/content.*timed out/i);
      expect(ticks).toBeGreaterThan(1);
      await filter.close();
      expect(workers()).toHaveLength(1);
    } finally {
      clearInterval(timer);
    }
  });

  it('poisons a failed pass without respawning for queued or later work', async () => {
    const filter = client('/(a+)+$/', { jobTimeoutMs: 100 });
    const signal = new AbortController().signal;
    const results = await Promise.allSettled([
      filter.project('a'.repeat(32_000) + '!', { signal }),
      filter.project('Other source', { signal }),
    ]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(results[0]).toMatchObject({ reason: { name: 'ContentFilterError', scope: 'job' } });
    expect(results[1]).toMatchObject({ reason: { name: 'ContentFilterBatchCancelledError' } });
    await expect(filter.project('Later source', { signal })).rejects.toThrow(/content/i);
    expect(workers()).toHaveLength(1);
    const recovered = client('/secret/g');
    expect((await recovered.project('secret remaining', { signal })).text).toBe(' remaining');
    expect(workers()).toHaveLength(2);
  });

  it.each(['exit-init', 'malformed-init', 'exit-project', 'malformed-project'])(
    'rejects %s and reaps the child',
    async (mode) => {
      vi.stubEnv('OHS_CONTENT_FILTER_MODE', mode);
      const filter = client();
      await expect(
        filter.project('Private source body', { signal: new AbortController().signal }),
      ).rejects.toThrow(/content/i);
      await filter.close();
      expect(workers()).toHaveLength(1);
    },
  );

  it('bounds worker startup separately from projection execution', async () => {
    vi.stubEnv('OHS_CONTENT_FILTER_MODE', 'hang-init');
    const filter = client('/secret/g', { startupTimeoutMs: 1000, jobTimeoutMs: 20 });
    const pending = filter.project('secret', { signal: new AbortController().signal });
    await expect(pending).rejects.toMatchObject({
      name: 'ContentFilterError',
      scope: 'worker',
    });
    await expect(pending).rejects.toThrow(/content.*initializ.*timed out/i);
    await filter.close();
    expect(workers()).toHaveLength(1);
  });

  it('rejects an already aborted request before starting a child', async () => {
    const controller = new AbortController();
    controller.abort(new Error('Stopped before filtering'));
    await expect(client().project('secret', { signal: controller.signal })).rejects.toThrow(
      'Stopped before filtering',
    );
    expect(workers()).toEqual([]);
  });

  it('reaps a starting worker when its last queued request is canceled', async () => {
    vi.stubEnv('OHS_CONTENT_FILTER_MODE', 'hang-init');
    const filter = client('/secret/g', { startupTimeoutMs: 5000 });
    const controller = new AbortController();
    const pending = filter.project('secret', { signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow('Canceled during startup');
    const startupDeadline = Date.now() + 3000;
    while (!workers().length) {
      if (Date.now() > startupDeadline) throw new Error('Fixture did not start');
      await delay(10);
    }
    controller.abort(new Error('Canceled during startup'));
    await rejected;
    const pid = workers()[0]!.pid;
    const exitDeadline = Date.now() + 500;
    while (true) {
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
      if (Date.now() > exitDeadline) throw new Error('Canceled startup left its worker alive');
      await delay(10);
    }
  });

  it('cancels active work and prevents a late reply from winning', async () => {
    vi.stubEnv('OHS_CONTENT_FILTER_MODE', 'delay-project');
    const filter = client();
    const controller = new AbortController();
    const outcome = filter.project('secret visible', { signal: controller.signal });
    const rejected = expect(outcome).rejects.toThrow('Stopped active filtering');
    await dispatched();
    controller.abort(new Error('Stopped active filtering'));
    await rejected;
    await filter.close();
    expect(workers()).toHaveLength(1);
  });

  it('removes a canceled queued request without discarding unrelated active work', async () => {
    vi.stubEnv('OHS_CONTENT_FILTER_MODE', 'delay-project');
    const filter = client();
    const first = filter.project('secret first', { signal: new AbortController().signal });
    await dispatched();
    const controller = new AbortController();
    const queued = filter.project('secret canceled', { signal: controller.signal });
    const rejected = expect(queued).rejects.toThrow('Canceled queued filtering');
    controller.abort(new Error('Canceled queued filtering'));
    await rejected;
    expect((await first).text).toBe(' first');
    expect(workers()).toHaveLength(1);
  });

  it('closes idempotently and does not start work after disposal', async () => {
    const filter = client();
    await filter.close();
    await filter.close();
    await expect(
      filter.project('secret', { signal: new AbortController().signal }),
    ).rejects.toThrow(/closed|stopped/i);
    expect(workers()).toEqual([]);
  });

  it('reports a failed kill and retains the real child for a later confirmed reap', async () => {
    const filter = client();
    await filter.project('visible source', { signal: new AbortController().signal });
    const pid = workers()[0]!.pid;
    const kill = vi.spyOn(ChildProcess.prototype, 'kill').mockReturnValue(false);
    try {
      await expect(filter.close()).rejects.toThrow(/terminat|exit|kill/i);
      expect(() => process.kill(pid, 0)).not.toThrow();
      kill.mockRestore();
      await filter.close();
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    } finally {
      kill.mockRestore();
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* Already reaped. */
      }
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 2000 });
    }
  });

  it('releases the handle and process exit listener after a real OS spawn failure', async () => {
    const baseline = process.listenerCount('exit');
    const filter = client('/secret/g', {
      execPath: path.join(directory, 'missing-node-executable'),
    });
    await expect(
      filter.project('visible source', { signal: new AbortController().signal }),
    ).rejects.toThrow(/worker failed/i);
    await filter.close();
    expect(process.listenerCount('exit')).toBe(baseline);
    expect(workers()).toEqual([]);
  });

  it('accepts actual exit when kill reports a concurrent exit race', async () => {
    const filter = client();
    await filter.project('visible source', { signal: new AbortController().signal });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- invoked with its original child receiver below
    const original = ChildProcess.prototype.kill;
    const kill = vi.spyOn(ChildProcess.prototype, 'kill').mockImplementation(function (
      this: ChildProcess,
      signal,
    ) {
      original.call(this, signal);
      return false;
    });
    try {
      await filter.close();
      expect(() => process.kill(workers()[0]!.pid, 0)).toThrow(
        expect.objectContaining({ code: 'ESRCH' }),
      );
    } finally {
      kill.mockRestore();
    }
  });

  it('runs the compiled worker without the development loader', async () => {
    const compiled = new URL('../dist/src/indexing/content-filter-worker.js', import.meta.url);
    expect(fs.existsSync(fileURLToPath(compiled))).toBe(true);
    const filter = client('/secret/g', { workerUrl: compiled });
    expect(
      (await filter.project('original secret source', { signal: new AbortController().signal }))
        .text,
    ).toBe('original   source');
  });
});
