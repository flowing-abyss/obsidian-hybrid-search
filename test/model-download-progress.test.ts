import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

const transformers = vi.hoisted(() => ({
  env: { cacheDir: '', logLevel: 30 },
  model: vi.fn(),
  tokenizer: vi.fn(),
  pipeline: vi.fn(),
}));
vi.mock('@huggingface/transformers', () => ({
  env: transformers.env,
  LogLevel: { ERROR: 40 },
  PreTrainedModel: { from_pretrained: transformers.model },
  AutoModelForSequenceClassification: { from_pretrained: transformers.model },
  AutoTokenizer: { from_pretrained: transformers.tokenizer },
  pipeline: transformers.pipeline,
}));

let directory: string;
const stderrTTY = process.stderr.isTTY;
const stdoutTTY = process.stdout.isTTY;
beforeEach(() => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ohs-download-progress-'));
  vi.spyOn(os, 'homedir').mockReturnValue(directory);
  transformers.tokenizer.mockResolvedValue(() => ({}));
  transformers.model.mockReset();
  transformers.env.logLevel = 30;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  process.stderr.isTTY = stderrTTY;
  process.stdout.isTTY = stdoutTTY;
  fs.rmSync(directory, { recursive: true, force: true });
});

function captureTerminal(): () => string {
  const chunks: string[] = [];
  process.stderr.isTTY = true;
  process.stdout.isTTY = true;
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  });
  return () => chunks.join('');
}

function emitTransfer(callback?: (event: unknown) => void): void {
  callback?.({ status: 'initiate', name: 'test/model', file: 'onnx/model.onnx' });
  callback?.({ status: 'download', name: 'test/model', file: 'onnx/model.onnx' });
  callback?.({
    status: 'progress',
    name: 'test/model',
    file: 'onnx/model.onnx',
    loaded: 25,
    total: 100,
    progress: 25,
  });
}

describe('model download reporting', () => {
  it('keeps library metadata warnings quiet without suppressing errors', async () => {
    const terminal = captureTerminal();
    transformers.model.mockImplementation(() => {
      if (transformers.env.logLevel <= 30) process.stderr.write('model metadata warning\n');
      if (transformers.env.logLevel <= 40) process.stderr.write('model download error\n');
      return Promise.reject(new Error('download failed'));
    });
    const { loadRerankerModel } = await import('../src/reranker-model.js');
    await assert.rejects(loadRerankerModel('test/model', 256, 'cpu'), /download failed/);
    assert.equal(terminal(), 'model download error\n');
  });
  it.each(['cpu', 'webgpu'] as const)(
    'reports actual %s reranker transfers and clears after loading',
    async (device) => {
      const { loadRerankerModel } = await import('../src/reranker-model.js');
      const snapshots: unknown[] = [];
      transformers.model.mockImplementation(
        (_name, options: { progress_callback?: (event: unknown) => void }) => {
          emitTransfer(options.progress_callback);
          return Promise.resolve(() => ({}));
        },
      );
      await loadRerankerModel('test/model', 256, device, undefined, (snapshot) =>
        snapshots.push(snapshot),
      );
      assert.ok(
        snapshots.some((snapshot) => JSON.stringify(snapshot) === '{"loaded":25,"total":100}'),
      );
      assert.equal(snapshots.at(-1), null);
    },
  );

  it('clears a failed CPU model download before the error reaches its caller', async () => {
    const { loadRerankerModel } = await import('../src/reranker-model.js');
    const snapshots: unknown[] = [];
    transformers.model.mockImplementation(
      (_name, options: { progress_callback?: (event: unknown) => void }) => {
        emitTransfer(options.progress_callback);
        return Promise.reject(new Error('download failed'));
      },
    );
    await assert.rejects(
      loadRerankerModel('test/model', 256, 'cpu', undefined, (snapshot) =>
        snapshots.push(snapshot),
      ),
      /download failed/,
    );
    assert.ok(snapshots.length > 1);
    assert.equal(snapshots.at(-1), null);
  });

  it.each(['embedding', 'reranker'])(
    'shows %s download progress during loading and removes it before results',
    async (kind) => {
      const terminal = captureTerminal();
      vi.useFakeTimers();
      const { enableModelDownloadProgress } = await import('../src/model-download-progress.js');
      enableModelDownloadProgress();
      vi.stubEnv('OPENAI_API_KEY', '');
      vi.stubEnv('OPENAI_BASE_URL', '');
      vi.stubEnv('LOCAL_EMBEDDING_MODEL', 'test/model');
      vi.stubEnv('OBSIDIAN_VAULT_PATH', directory);
      const load = async (options: { progress_callback?: (event: unknown) => void }) => {
        emitTransfer(options.progress_callback);
        await vi.advanceTimersByTimeAsync(150);
        assert.match(terminal(), /25%/);
        assert.ok(terminal().includes('█') && terminal().includes('░'));
        return () =>
          Promise.resolve({
            data: new Float32Array([1, 2]),
            logits: { data: new Float32Array([2]), dims: [1, 1] },
          });
      };
      transformers.model.mockImplementation(
        (_name, options: { progress_callback?: (event: unknown) => void }) => load(options),
      );
      transformers.pipeline.mockImplementation(
        (_task, _name, options: { progress_callback?: (event: unknown) => void }) => load(options),
      );
      if (kind === 'embedding') {
        const { embed } = await import('../src/embedder.js');
        assert.deepEqual(await embed(['query'], 'query'), [new Float32Array([1, 2])]);
      } else {
        const { loadRerankerModel } = await import('../src/reranker-model.js');
        const model = await loadRerankerModel('test/model', 256, 'cpu');
        assert.deepEqual(await model([{ text: 'q', text_pair: 'd' }]), [
          [{ label: 'LABEL_1', score: 2 }],
        ]);
      }
      assert.ok(terminal().endsWith('\r\x1b[2K'));
      const ended = terminal();
      await vi.advanceTimersByTimeAsync(1000);
      assert.equal(terminal(), ended, 'completion must stop redraws');
    },
  );

  it.each(['cached', 'non-tty', 'disabled', 'small'])('keeps %s loads silent', async (mode) => {
    const terminal = captureTerminal();
    vi.useFakeTimers();
    const { enableModelDownloadProgress } = await import('../src/model-download-progress.js');
    if (mode !== 'disabled') enableModelDownloadProgress();
    if (mode === 'non-tty') process.stderr.isTTY = false;
    if (mode === 'cached') {
      const artifact = path.join(directory, '.cache/huggingface/test/model/onnx/model.onnx');
      fs.mkdirSync(path.dirname(artifact), { recursive: true });
      fs.writeFileSync(artifact, 'cached');
    }
    transformers.model.mockImplementation(
      async (_name, options: { progress_callback?: (event: unknown) => void }) => {
        emitTransfer(options.progress_callback);
        if (mode !== 'small') await vi.advanceTimersByTimeAsync(150);
        return () => ({});
      },
    );
    const { loadRerankerModel } = await import('../src/reranker-model.js');
    await loadRerankerModel('test/model', 256, 'cpu');
    await vi.advanceTimersByTimeAsync(1000);
    assert.equal(terminal(), '');
  });
});
