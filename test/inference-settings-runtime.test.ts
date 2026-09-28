import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({
  pipeline: vi.fn(),
  defaultModel: vi.fn(),
  otherModel: vi.fn(),
}));
vi.mock('@huggingface/transformers', () => ({
  env: { cacheDir: '', logLevel: 30 },
  LogLevel: { ERROR: 40 },
  pipeline: calls.pipeline,
  AutoTokenizer: { from_pretrained: vi.fn().mockResolvedValue(() => ({})) },
  PreTrainedModel: { from_pretrained: calls.defaultModel },
  AutoModelForSequenceClassification: { from_pretrained: calls.otherModel },
}));

const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'ohs-threads-vault-'));
const oldVault = process.env.OBSIDIAN_VAULT_PATH;
const oldKey = process.env.OPENAI_API_KEY;
const oldBase = process.env.OPENAI_BASE_URL;
process.env.OBSIDIAN_VAULT_PATH = vault;

let cache: string;
type ModelOptions = { session_options?: { intraOpNumThreads: number } };
beforeEach(() => {
  vi.resetModules();
  calls.pipeline.mockReset();
  calls.defaultModel.mockReset();
  calls.otherModel.mockReset();
  cache = fs.mkdtempSync(path.join(os.tmpdir(), 'ohs-threads-runtime-'));
  vi.stubEnv('XDG_CACHE_HOME', cache);
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  const fakePipeline = Object.assign(async () => ({ data: new Float32Array([1, 2]) }), {
    tokenizer: { model_max_length: 512, encode: () => [1, 2] },
    model: { config: { max_position_embeddings: 512 } },
  });
  calls.pipeline.mockResolvedValue(fakePipeline);
  calls.defaultModel.mockResolvedValue(async () => ({}));
  calls.otherModel.mockResolvedValue(async () => ({}));
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(cache, { recursive: true, force: true });
});
afterAll(() => {
  fs.rmSync(vault, { recursive: true, force: true });
  if (oldVault === undefined) delete process.env.OBSIDIAN_VAULT_PATH;
  else process.env.OBSIDIAN_VAULT_PATH = oldVault;
  if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = oldKey;
  if (oldBase === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = oldBase;
});

it('applies saved threads to one shared local pipeline before dimension probe and embeddings', async () => {
  const settings = await import('../src/inference-settings.js');
  settings.saveCpuThreads(5);
  const embedder = await import('../src/embedder.js');
  await embedder.getEmbeddingDim({ refresh: true });
  await embedder.embed(['document'], 'document');
  await embedder.embed(['query'], 'query');
  assert.equal(calls.pipeline.mock.calls.length, 1);
  const options = calls.pipeline.mock.calls[0]?.[2] as ModelOptions | undefined;
  assert.deepEqual(options?.session_options, { intraOpNumThreads: 5 });
});

it('omits native option for zero and ignores later external file edits', async () => {
  const settings = await import('../src/inference-settings.js');
  assert.equal(settings.getCpuSessionOptions(), undefined);
  fs.mkdirSync(path.join(cache, 'obsidian-hybrid-search'), { recursive: true });
  fs.writeFileSync(
    path.join(cache, 'obsidian-hybrid-search', 'inference-settings.json'),
    JSON.stringify({ version: 1, threads: 8 }),
  );
  const embedder = await import('../src/embedder.js');
  await embedder.getEmbeddingDim({ refresh: true });
  const options = calls.pipeline.mock.calls[0]?.[2] as ModelOptions | undefined;
  assert.equal('session_options' in (options ?? {}), false);
});

it('passes preference to both CPU reranker loaders and excludes it from webgpu', async () => {
  (await import('../src/inference-settings.js')).saveCpuThreads(6);
  const { loadRerankerModel } = await import('../src/reranker-model.js');
  await loadRerankerModel('onnx-community/gte-multilingual-reranker-base', 256, 'cpu');
  await loadRerankerModel('other/model', 256, 'cpu');
  await loadRerankerModel('other/model', 256, 'webgpu');
  const defaultOptions = calls.defaultModel.mock.calls[0]?.[1] as ModelOptions | undefined;
  const otherCpuOptions = calls.otherModel.mock.calls[0]?.[1] as ModelOptions | undefined;
  const gpuOptions = calls.otherModel.mock.calls[1]?.[1] as ModelOptions | undefined;
  assert.deepEqual(defaultOptions?.session_options, { intraOpNumThreads: 6 });
  assert.deepEqual(otherCpuOptions?.session_options, { intraOpNumThreads: 6 });
  assert.equal('session_options' in (gpuOptions ?? {}), false);
});

it('leaves remote embedding requests unchanged and does not create local sessions', async () => {
  (await import('../src/inference-settings.js')).saveCpuThreads(4);
  process.env.OPENAI_API_KEY = 'key';
  process.env.OPENAI_BASE_URL = 'https://example.test/v1';
  const fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ data: [{ embedding: [1, 2], index: 0 }] }),
  });
  vi.stubGlobal('fetch', fetch);
  try {
    const { embed } = await import('../src/embedder.js');
    await embed(['hello'], 'query');
    assert.equal(calls.pipeline.mock.calls.length, 0);
    const requests = fetch.mock.calls as Array<[unknown, { body: string }]>;
    const requestBody = JSON.parse(requests[0]![1].body) as { input: string[] };
    assert.equal(requestBody.input[0], 'hello');
  } finally {
    vi.unstubAllGlobals();
  }
});
