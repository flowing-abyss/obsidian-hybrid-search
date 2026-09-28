import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import { enableModelDownloadProgress } from '../src/model-download-progress.js';
import { RerankerGpu } from '../src/reranker-gpu.js';

const workerUrl = new URL('./fixtures/reranker-worker.ts', import.meta.url);
let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ohs-worker-lifetime-'));
  vi.stubEnv('OHS_FIXTURE_PID_FILE', path.join(directory, 'pid'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});
describe('isolated GPU worker', () => {
  it.each(['download-success', 'download-failure'])(
    'shows and clears child progress after %s',
    async (mode) => {
      const originalStderrTTY = process.stderr.isTTY;
      const originalStdoutTTY = process.stdout.isTTY;
      const chunks: string[] = [];
      const output = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation((chunk: string | Uint8Array) => {
          chunks.push(String(chunk));
          return true;
        });
      process.stderr.isTTY = true;
      process.stdout.isTTY = true;
      enableModelDownloadProgress();
      const gpu = new RerankerGpu(mode, 256, { workerUrl });
      try {
        if (mode === 'download-success') await gpu.load();
        else await assert.rejects(gpu.load());
        assert.match(chunks.join(''), /25%/);
        assert.equal(chunks.at(-1), '\r\x1b[2K');
      } finally {
        await gpu.close();
        process.stderr.isTTY = originalStderrTTY;
        process.stdout.isTTY = originalStdoutTTY;
        output.mockRestore();
      }
    },
  );
  it('reuses a worker for model loading and multiple requests', async () => {
    const gpu = new RerankerGpu('healthy', 256, { workerUrl });
    try {
      assert.equal(await gpu.probe(), true);
      await gpu.load();
      assert.deepEqual(
        await gpu.scoreAll('q', [
          { title: 'A', snippet: 'a' },
          { title: 'B', snippet: 'b' },
        ]),
        [2, -1],
      );
      assert.equal(await gpu.probe(), true);
    } finally {
      await gpu.close();
    }
  });

  it.each(['crash', 'error', 'hang'])(
    'rejects %s and reaps the worker within the deadline',
    async (mode) => {
      const gpu = new RerankerGpu(mode, 256, { workerUrl, probeTimeoutMs: 750 });
      const started = performance.now();
      try {
        await assert.rejects(gpu.probe());
        await gpu.close();
        assert.ok(
          performance.now() - started < 3000,
          'a five-second blocked child must be terminated',
        );
        const pid = Number(fs.readFileSync(path.join(directory, 'pid'), 'utf8'));
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      } finally {
        await gpu.close();
      }
    },
  );
});
