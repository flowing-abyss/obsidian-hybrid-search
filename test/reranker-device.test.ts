import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import { DEFAULT_RERANKER_MODEL } from '../src/config.js';
import { RerankerDevice } from '../src/reranker-device.js';

let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ohs-device-route-'));
  vi.stubEnv('XDG_CACHE_HOME', directory);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});
const candidates = [
  { title: 'A', snippet: 'a' },
  { title: 'B', snippet: 'b' },
];

function backend(events: string[], mode = 'healthy') {
  return {
    probe() {
      events.push('probe');
      return Promise.resolve(mode !== 'absent');
    },
    load() {
      events.push('load');
      return mode === 'load-error' ? Promise.reject(new Error('load failed')) : Promise.resolve();
    },
    scoreAll() {
      events.push('score');
      return mode === 'late-error'
        ? Promise.reject(new Error('second batch failed'))
        : Promise.resolve(mode === 'invalid' ? [1, Number.NaN] : [2, -1]);
    },
    close() {
      events.push('close');
      return Promise.resolve();
    },
  };
}

describe('automatic reranker routing', () => {
  it('does not load GPU weights when the probe fails, including on a later instance', async () => {
    const events: string[] = [];
    const cpu = () => Promise.resolve([0.8, -0.3]);
    const first = new RerankerDevice(DEFAULT_RERANKER_MODEL, 256, backend(events, 'absent'));
    assert.deepEqual(await first.scoreAll('q', candidates, cpu), [0.8, -0.3]);
    const next = new RerankerDevice(DEFAULT_RERANKER_MODEL, 256, backend(events));
    assert.deepEqual(await next.scoreAll('q', candidates, cpu), [0.8, -0.3]);
    assert.deepEqual(
      events.filter((e) => e !== 'close'),
      ['probe'],
    );
  });

  it('probes before loading weights and reuses a successful device selection', async () => {
    const events: string[] = [];
    const cpu = () => Promise.reject(new Error('CPU should not run'));
    const first = new RerankerDevice(DEFAULT_RERANKER_MODEL, 256, backend(events));
    assert.deepEqual(await first.scoreAll('q', candidates, cpu), [2, -1]);
    const next = new RerankerDevice(DEFAULT_RERANKER_MODEL, 256, backend(events));
    assert.deepEqual(await next.scoreAll('q', candidates, cpu), [2, -1]);
    assert.deepEqual(events, ['probe', 'load', 'score', 'load', 'score']);
  });

  it.each(['load-error', 'late-error', 'invalid'])(
    'reruns the whole request on CPU after %s and persists that decision',
    async (mode) => {
      const events: string[] = [];
      let cpuCalls = 0;
      const cpu = () => {
        cpuCalls++;
        return Promise.resolve([0.8, -0.3]);
      };
      const first = new RerankerDevice(DEFAULT_RERANKER_MODEL, 256, backend(events, mode));
      assert.deepEqual(await first.scoreAll('q', candidates, cpu), [0.8, -0.3]);
      const priorEvents = events.filter((e) => e !== 'close');
      const next = new RerankerDevice(DEFAULT_RERANKER_MODEL, 256, backend(events));
      assert.deepEqual(await next.scoreAll('q', candidates, cpu), [0.8, -0.3]);
      assert.deepEqual(
        events.filter((e) => e !== 'close'),
        priorEvents,
      );
      assert.equal(cpuCalls, 2);
    },
  );

  it('serializes concurrent requests without spuriously choosing CPU', async () => {
    const events: string[] = [];
    const route = new RerankerDevice(DEFAULT_RERANKER_MODEL, 256, backend(events));
    const cpu = () => Promise.reject(new Error('CPU should not run'));
    const result = await Promise.all([
      route.scoreAll('a', candidates, cpu),
      route.scoreAll('b', candidates, cpu),
    ]);
    assert.deepEqual(result, [
      [2, -1],
      [2, -1],
    ]);
    assert.equal(events.filter((e) => e === 'probe').length, 1);
  });
});
