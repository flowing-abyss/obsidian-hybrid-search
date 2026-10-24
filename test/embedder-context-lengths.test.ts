import assert from 'node:assert/strict';
import { afterEach, beforeEach, it, vi } from 'vitest';
const { getContextLength, getDocumentTokenPolicy, clearOllamaSemaphore } =
  await import('../src/inference/embedder.js');

beforeEach(() => {
  vi.stubEnv('OPENAI_BASE_URL', 'https://api.test/v1');
  vi.stubEnv('OPENAI_API_KEY', 'fixture-only');
  clearOllamaSemaphore();
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => {
  clearOllamaSemaphore();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const contexts: [string, number][] = [
  ['nvidia/nemotron-3.5-embed-1b:free', 32768],
  ['nvidia/nemotron-3.5-embed-8b:free', 32768],
  ['liquid/lfm-2.5-embedding-350m:free', 512],
  ['voyageai/voyage-code-4', 32000],
  ['voyageai/voyage-multimodal-3.5', 32000],
  ['voyageai/voyage-4-lite', 32000],
  ['voyageai/voyage-4', 32000],
  ['voyageai/voyage-4-large', 32000],
  ['nvidia/nemotron-3-embed-1b:free', 32768],
  ['google/gemini-embedding-2', 8192],
  ['google/gemini-embedding-2-preview', 8192],
  ['perplexity/pplx-embed-v1-4b', 32000],
  ['perplexity/pplx-embed-v1-0.6b', 32000],
  ['nvidia/llama-nemotron-embed-vl-1b-v2:free', 131072],
  ['gemini-embedding-2', 8192],
  ['gemini-embedding-2-preview', 8192],
  ['gemini-embedding-001', 2048],
  ['google/gemini-embedding-001', 2048],
  ['voyage-code-4', 32000],
  ['codestral-embed', 8192],
  ['codestral-embed-2505', 8192],
  ['mistral-embed-2312', 8192],
  ['embed-v4.0', 128000],
  ['embed-v5.0-pro', 128000],
  ['embed-v5.0-fast', 128000],
  ['qwen/qwen3-embedding-8b', 32000],
  ['qwen3-embedding-8b', 32000],
  ['baai/bge-m3', 8192],
  ['mistralai/mistral-embed', 8192],
  ['cohere/embed-multilingual-v3.0', 512],
  ['nvidia/llama-nemotron-embed-vl-1b-v2', 131072],
];

for (const [model, limit] of contexts) {
  it(`uses the documented context for ${model} without a model lookup`, async () => {
    vi.stubEnv('OPENAI_EMBEDDING_MODEL', model);
    assert.equal(await getContextLength(), limit);
    assert.equal(await getContextLength(), limit);
    assert.equal(vi.mocked(fetch).mock.calls.length, 0);
  });
}

for (const [model, context, documentLimit] of [
  ['embeddinggemma-2:270m-q8_0-text', 8192, 8128],
  ['embeddinggemma-2:latest', 8192, 8128],
  ['embeddinggemma:300m', 2048, 2027],
] as const) {
  it(`uses the conservative Ollama context for ${model}`, async () => {
    vi.stubEnv('OPENAI_BASE_URL', 'http://localhost:11434/v1');
    vi.stubEnv('OPENAI_EMBEDDING_MODEL', model);
    assert.equal(await getContextLength(), context);
    assert.equal((await getDocumentTokenPolicy()).limit, documentLimit);
    assert.equal(vi.mocked(fetch).mock.calls.length, 0);
  });
}

it('uses the smaller Gemini 001 document budget without changing its counter', async () => {
  vi.stubEnv('OPENAI_EMBEDDING_MODEL', 'gemini-embedding-001');
  const policy = await getDocumentTokenPolicy();
  assert.equal(policy.limit, 2027);
  assert.ok(policy.count('knowledge management') > 0);
  assert.equal(vi.mocked(fetch).mock.calls.length, 0);
});

it('retains the unknown-model fallback', async () => {
  vi.stubEnv('OPENAI_EMBEDDING_MODEL', 'unknown-fixture-model');
  vi.mocked(fetch).mockRejectedValue(new Error('fixture metadata unavailable'));
  assert.equal(await getContextLength(), 512);
  assert.equal(vi.mocked(fetch).mock.calls.length, 1);
});
