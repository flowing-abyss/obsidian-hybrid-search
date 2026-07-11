import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, it, vi } from 'vitest';
import { embedChunksWithRecovery } from '../src/chunk-embedding.js';
import { createChunkBoundaryIndex, estimateTokens, type Chunk } from '../src/chunker.js';
import * as tokenCounter from '../src/token-counter.js';

const huggingFaceMocks = vi.hoisted(() => ({ pipeline: vi.fn() }));
vi.mock('@huggingface/transformers', () => ({
  env: {},
  pipeline: huggingFaceMocks.pipeline,
}));

const vaultDir = mkdtempSync(path.join(tmpdir(), 'ohs-embedder-test-'));
process.env.OBSIDIAN_VAULT_PATH = vaultDir;
// Force API mode so we can mock fetch without loading the local model
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_BASE_URL = 'https://api.test/v1';

afterAll(() => {
  rmSync(vaultDir, { recursive: true, force: true });
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const {
  embed,
  embedDetailed,
  LOCAL_MODEL,
  clearOllamaSemaphore,
  getDocumentTokenPolicy,
  prepareEmbeddingInput,
} = await import('../src/embedder.js');

describe('LOCAL_MODEL constant', () => {
  it('is Xenova/multilingual-e5-small', () => {
    assert.equal(LOCAL_MODEL, 'Xenova/multilingual-e5-small');
  });
});

describe('embed() — success', () => {
  const fakeEmbedding = new Array(384).fill(0.1);

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => ({ data: [{ embedding: fakeEmbedding, index: 0 }] }),
      }),
    );
  });

  afterEach(() => vi.restoreAllMocks());

  it('returns Float32Array on success', async () => {
    const result = await embed(['hello world'], 'document');
    assert.equal(result.length, 1);
    const first = result[0];
    assert.ok(first instanceof Float32Array, 'result should be Float32Array');
    assert.equal(first.length, 384);
  });

  it('never returns a zero-filled Float32Array', async () => {
    const result = await embed(['hello world'], 'document');
    const isZero = result[0] !== null && result[0]!.every((v) => v === 0);
    assert.ok(!isZero, 'should not return zero vector');
  });
});

describe('E5-style prefix for BGE / E5 models via API', () => {
  const fakeEmbedding = new Array(384).fill(0.1);
  let capturedBody: unknown;

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, opts: { body: string }) => {
        capturedBody = JSON.parse(opts.body);
        return {
          ok: true,
          status: 200,
          json: () => ({ data: [{ embedding: fakeEmbedding, index: 0 }] }),
        };
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.OPENAI_EMBEDDING_MODEL;
  });

  it('does NOT add prefix for BGE model document embedding', async () => {
    process.env.OPENAI_EMBEDDING_MODEL = 'bge-m3';
    await embed(['hello world'], 'document');
    assert.equal((capturedBody as { input: string[] }).input[0], 'hello world');
  });

  it('does NOT add prefix for BGE model query embedding', async () => {
    process.env.OPENAI_EMBEDDING_MODEL = 'baai/bge-m3';
    await embed(['backlinks'], 'query');
    assert.equal((capturedBody as { input: string[] }).input[0], 'backlinks');
  });

  it('adds "passage: " prefix for E5 model', async () => {
    process.env.OPENAI_EMBEDDING_MODEL = 'intfloat/multilingual-e5-large';
    await embed(['hello'], 'document');
    assert.equal((capturedBody as { input: string[] }).input[0], 'passage: hello');
  });

  it('does NOT add prefix for OpenAI model', async () => {
    process.env.OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
    await embed(['hello world'], 'document');
    assert.equal((capturedBody as { input: string[] }).input[0], 'hello world');
  });

  it('does NOT add prefix for Voyage model', async () => {
    process.env.OPENAI_EMBEDDING_MODEL = 'voyage-4';
    await embed(['hello world'], 'query');
    assert.equal((capturedBody as { input: string[] }).input[0], 'hello world');
  });
});

describe('local document token policy', () => {
  afterEach(() => {
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_BASE_URL = 'https://api.test/v1';
    delete process.env.LOCAL_EMBEDDING_MODEL;
    huggingFaceMocks.pipeline.mockReset();
    clearOllamaSemaphore();
  });

  it('uses the prepared-input estimator without initializing the pipeline', async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    process.env.LOCAL_EMBEDDING_MODEL = 'Xenova/multilingual-e5-small';
    clearOllamaSemaphore();
    const policy = await getDocumentTokenPolicy();

    assert.equal(prepareEmbeddingInput('hello', 'document'), 'passage: hello');
    assert.equal(policy.count('hello'), estimateTokens('passage: hello'));
    assert.equal(huggingFaceMocks.pipeline.mock.calls.length, 0);
  });

  it('does not initialize the pipeline to discover an unknown local model context', async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    process.env.LOCAL_EMBEDDING_MODEL = 'custom/local-e5-model';
    clearOllamaSemaphore();

    const policy = await getDocumentTokenPolicy();

    assert.ok(policy.limit > 0);
    assert.equal(policy.count('hello'), estimateTokens('passage: hello'));
    assert.equal(huggingFaceMocks.pipeline.mock.calls.length, 0);
  });

  it('uses loaded pipeline context metadata to prevent unknown-model truncation', async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    process.env.LOCAL_EMBEDDING_MODEL = 'custom/local-e5-model';
    clearOllamaSemaphore();
    const policy = await getDocumentTokenPolicy();
    assert.equal(policy.limit, 506, 'shaping uses the configured fallback without model loading');
    const encode = vi.fn((text: string) =>
      new Array<number>(text.includes('oversized') ? 253 : 252).fill(1),
    );
    const pipeline = Object.assign(
      vi.fn().mockResolvedValue({ data: new Float32Array([0.1, 0.2]) }),
      { tokenizer: { encode, model_max_length: 256 } },
    );
    huggingFaceMocks.pipeline.mockResolvedValue(pipeline);

    const outcomes = await embedDetailed(['fits', 'oversized'], 'document');

    assert.equal(outcomes[0]?.ok, true);
    assert.deepEqual(outcomes[1], {
      ok: false,
      kind: 'input_too_long',
      message: 'Local embedding input exceeds the 252 token limit (253 tokens)',
    });
    assert.equal(pipeline.mock.calls.length, 1);
    assert.equal(pipeline.mock.calls[0]?.[0], 'passage: fits');
  });

  it('uses the smaller sane limit when unknown-model tokenizer and model metadata conflict', async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    process.env.LOCAL_EMBEDDING_MODEL = 'custom/local-e5-model';
    clearOllamaSemaphore();
    const encode = vi.fn(() => new Array<number>(253).fill(1));
    const pipeline = Object.assign(
      vi.fn().mockResolvedValue({ data: new Float32Array([0.1, 0.2]) }),
      {
        tokenizer: { encode, model_max_length: 8192 },
        model: { config: { max_position_embeddings: 256 } },
      },
    );
    huggingFaceMocks.pipeline.mockResolvedValue(pipeline);

    const [outcome] = await embedDetailed(['oversized'], 'document');

    assert.deepEqual(outcome, {
      ok: false,
      kind: 'input_too_long',
      message: 'Local embedding input exceeds the 252 token limit (253 tokens)',
    });
    assert.equal(pipeline.mock.calls.length, 0);
  });

  it('initializes one pipeline for concurrent detailed embedding calls', async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    clearOllamaSemaphore();
    const pipeline = Object.assign(
      vi.fn().mockResolvedValue({ data: new Float32Array([0.1, 0.2]) }),
      { tokenizer: { encode: vi.fn(() => [101, 11, 102]) } },
    );
    huggingFaceMocks.pipeline.mockResolvedValue(pipeline);

    const [first, second] = await Promise.all([
      embedDetailed(['first'], 'document'),
      embedDetailed(['second'], 'document'),
    ]);

    assert.equal(huggingFaceMocks.pipeline.mock.calls.length, 1);
    assert.equal(first[0]?.ok, true);
    assert.equal(second[0]?.ok, true);
  });

  it('exact-counts each prepared leaf once and infers only fitting leaves', async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    clearOllamaSemaphore();
    const encode = vi.fn((text: string, options: { add_special_tokens: boolean }) => {
      assert.deepEqual(options, { add_special_tokens: true });
      return text.includes('oversized')
        ? new Array<number>(507).fill(1)
        : new Array<number>(506).fill(1);
    });
    const pipeline = Object.assign(
      vi.fn().mockResolvedValue({ data: new Float32Array([0.1, 0.2]) }),
      { tokenizer: { encode } },
    );
    huggingFaceMocks.pipeline.mockResolvedValue(pipeline);

    const outcomes = await embedDetailed(['fits', 'oversized'], 'document');

    assert.deepEqual(
      encode.mock.calls.map(([text]) => text),
      ['passage: fits', 'passage: oversized'],
    );
    assert.equal(outcomes[0]?.ok, true);
    assert.deepEqual(outcomes[1], {
      ok: false,
      kind: 'input_too_long',
      message: 'Local embedding input exceeds the 506 token limit (507 tokens)',
    });
    assert.equal(pipeline.mock.calls.length, 1);
    assert.equal(pipeline.mock.calls[0]?.[0], 'passage: fits');
  });

  it('returns invalid_response without inference when the local tokenizer throws', async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    clearOllamaSemaphore();
    const pipeline = Object.assign(
      vi.fn().mockResolvedValue({ data: new Float32Array([0.1, 0.2]) }),
      {
        tokenizer: {
          encode: vi.fn(() => {
            throw new Error('tokenizer failed');
          }),
        },
      },
    );
    huggingFaceMocks.pipeline.mockResolvedValue(pipeline);

    const [outcome] = await embedDetailed(['small fallback input'], 'document');

    assert.deepEqual(outcome, {
      ok: false,
      kind: 'invalid_response',
      message: 'Local tokenizer failed to count prepared input',
    });
    assert.equal(pipeline.mock.calls.length, 0);
  });

  it('does not add tokenizer validation latency to local query embedding', async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    clearOllamaSemaphore();
    const encode = vi.fn(() => new Array<number>(507).fill(1));
    const pipeline = Object.assign(
      vi.fn().mockResolvedValue({ data: new Float32Array([0.1, 0.2]) }),
      { tokenizer: { encode } },
    );
    huggingFaceMocks.pipeline.mockResolvedValue(pipeline);

    const [outcome] = await embedDetailed(['search query'], 'query');

    assert.equal(outcome?.ok, true);
    assert.equal(encode.mock.calls.length, 0);
    assert.equal(pipeline.mock.calls[0]?.[0], 'query: search query');
  });

  it('counts recovery tree leaves once and infers only accepted children', async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    clearOllamaSemaphore();
    const inferred: string[] = [];
    const encode = vi.fn((prepared: string) => {
      const body = prepared.replace(/^passage: /, '');
      return new Array<number>(body.length > 2 ? 507 : 506).fill(1);
    });
    const pipeline = Object.assign(
      vi.fn(async (prepared: string) => {
        inferred.push(prepared);
        return { data: new Float32Array([0.1, 0.2]) };
      }),
      { tokenizer: { encode } },
    );
    huggingFaceMocks.pipeline.mockResolvedValue(pipeline);
    const source = 'abcdefgh';
    const parent: Chunk = {
      text: source,
      headingChain: [],
      charStart: 0,
      charEnd: source.length,
    };

    const result = await embedChunksWithRecovery({
      source,
      chunks: [parent],
      boundaryIndex: createChunkBoundaryIndex(source),
      project: (body) => body,
      embed: (texts) => embedDetailed(texts, 'document'),
    });

    assert.deepEqual(
      result.map(({ chunk }) => chunk.text),
      ['ab', 'cd', 'ef', 'gh'],
    );
    assert.equal(encode.mock.calls.length, 7, 'one exact count per attempted recovery-tree leaf');
    assert.deepEqual(inferred, ['passage: ab', 'passage: cd', 'passage: ef', 'passage: gh']);
  });
});

describe('Ollama document token policy', () => {
  afterEach(() => {
    process.env.OPENAI_BASE_URL = 'https://api.test/v1';
    delete process.env.OPENAI_EMBEDDING_MODEL;
    clearOllamaSemaphore();
    vi.restoreAllMocks();
  });

  it('uses the estimator without exact-counter construction for an OpenAI-named model', async () => {
    process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1';
    process.env.OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
    clearOllamaSemaphore();
    const exactCounterSpy = vi.spyOn(tokenCounter, 'createOpenAiTokenCounter');
    const text = '<https://example.com/?next=' + '%2Fprivate%2Fpath%3Fa%3D1'.repeat(40) + '>';

    const policy = await getDocumentTokenPolicy();

    assert.equal(policy.count(text), estimateTokens(text));
    assert.equal(exactCounterSpy.mock.calls.length, 0);
  });
});

describe('OpenAI document token policy fallback', () => {
  afterEach(() => {
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_BASE_URL = 'https://api.test/v1';
    delete process.env.OPENAI_EMBEDDING_MODEL;
    clearOllamaSemaphore();
    vi.restoreAllMocks();
  });

  it('uses the estimator when exact tokenizer initialization fails and retries later', async () => {
    process.env.OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
    clearOllamaSemaphore();
    const exactCount = vi.fn(() => 7);
    const exactCounterSpy = vi
      .spyOn(tokenCounter, 'createOpenAiTokenCounter')
      .mockRejectedValueOnce(new Error('corrupt cl100k ranks'))
      .mockResolvedValueOnce({ exact: true, count: exactCount });
    const text = 'counting continues after tokenizer initialization failure';

    const fallbackPolicy = await getDocumentTokenPolicy();
    const exactPolicy = await getDocumentTokenPolicy();

    assert.equal(fallbackPolicy.count(text), estimateTokens(text));
    assert.equal(exactPolicy.count(text), 7);
    assert.equal(exactCounterSpy.mock.calls.length, 2);
  });
});

describe('embed() — non-retryable failure', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns [null] on non-retryable 400 error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () => 'bad request',
      }),
    );

    const result = await embed(['hello world'], 'document');
    assert.equal(result.length, 1);
    assert.equal(result[0], null, 'should return null, not zero vector');
  });
});

describe('embed() — retryable failure (429)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('retries on 429 and succeeds on second attempt', async () => {
    const fakeEmbedding = new Array(384).fill(0.1);
    let callCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount < 2) {
          return { ok: false, status: 429, text: () => 'rate limited' };
        }
        return {
          ok: true,
          status: 200,
          json: () => ({ data: [{ embedding: fakeEmbedding, index: 0 }] }),
        };
      }),
    );

    vi.useFakeTimers();
    const embedPromise = embed(['hello'], 'document');
    await vi.runAllTimersAsync();
    const result = await embedPromise;
    vi.useRealTimers();

    assert.ok(result[0] instanceof Float32Array, 'should succeed after retry');
    assert.ok(callCount >= 2, `should have retried (callCount=${callCount})`);
  });

  it('returns null after exhausting all retries', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: () => 'rate limited',
      }),
    );

    vi.useFakeTimers();
    const embedPromise = embed(['hello'], 'document');
    await vi.runAllTimersAsync();
    const result = await embedPromise;
    vi.useRealTimers();

    assert.equal(result[0], null, 'should return null after all retries exhausted');
  });
});

describe('embed() — batch retry behavior', () => {
  afterEach(() => vi.restoreAllMocks());

  it('retries a transient batch twice without per-item fanout', async () => {
    const batchSizes: number[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, opts: { body: string }) => {
        const body = JSON.parse(opts.body) as { input: string[] };
        batchSizes.push(body.input.length);
        return { ok: false, status: 500, text: () => 'server error' };
      }),
    );

    vi.useFakeTimers();
    const embedPromise = embed(['first text', 'second text'], 'document');
    await vi.runAllTimersAsync();
    const result = await embedPromise;
    vi.useRealTimers();

    assert.deepEqual(result, [null, null]);
    assert.deepEqual(batchSizes, [2, 2, 2]);
  });
});

describe('embed() — Ollama semaphore serializes concurrent calls', () => {
  const fakeEmbedding = new Array(384).fill(0.1);

  beforeEach(() => {
    process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1';
    clearOllamaSemaphore();
  });

  afterEach(() => {
    delete process.env.OPENAI_BASE_URL;
    vi.restoreAllMocks();
  });

  it('serializes document embeddings to one in-flight request', async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise<{ ok: boolean; status: number; json: () => unknown }>((resolve) => {
          setTimeout(() => {
            inFlight--;
            resolve({
              ok: true,
              status: 200,
              json: () => ({ embeddings: [fakeEmbedding] }),
            });
          }, 50);
        });
      }),
    );

    const p1 = embed(['first'], 'document');
    const p2 = embed(['second'], 'document');
    const [r1, r2] = await Promise.all([p1, p2]);

    assert.ok(r1[0] instanceof Float32Array, 'first request should succeed');
    assert.ok(r2[0] instanceof Float32Array, 'second request should succeed');
    assert.equal(maxInFlight, 1, 'only one request should ever be in flight');
  });

  it('does NOT serialize query embeddings', async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise<{ ok: boolean; status: number; json: () => unknown }>((resolve) => {
          setTimeout(() => {
            inFlight--;
            resolve({
              ok: true,
              status: 200,
              json: () => ({ embeddings: [fakeEmbedding] }),
            });
          }, 50);
        });
      }),
    );

    const p1 = embed(['first query'], 'query');
    const p2 = embed(['second query'], 'query');
    const [r1, r2] = await Promise.all([p1, p2]);

    assert.ok(r1[0] instanceof Float32Array);
    assert.ok(r2[0] instanceof Float32Array);
    assert.equal(maxInFlight, 2, 'query requests should run in parallel');
  });
});

describe('embed() — API error response formats', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns null after retries when response has data.error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => ({ error: { message: 'model not found' } }),
      }),
    );

    vi.useFakeTimers();
    const embedPromise = embed(['hello'], 'document');
    await vi.runAllTimersAsync();
    const result = await embedPromise;
    vi.useRealTimers();

    assert.equal(result[0], null);
  });

  it('returns null after retries when response lacks data.data', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => ({ unexpected: 'format' }),
      }),
    );

    vi.useFakeTimers();
    const embedPromise = embed(['hello'], 'document');
    await vi.runAllTimersAsync();
    const result = await embedPromise;
    vi.useRealTimers();

    assert.equal(result[0], null);
  });

  it('returns null after retries when response embedding item is malformed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => ({ data: [{ embedding: ['bad'], index: 0 }] }),
      }),
    );

    vi.useFakeTimers();
    const embedPromise = embed(['hello'], 'document');
    await vi.runAllTimersAsync();
    const result = await embedPromise;
    vi.useRealTimers();

    assert.equal(result[0], null);
  });
});

describe('embed() — batch sorting by index', () => {
  afterEach(() => vi.restoreAllMocks());

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  function requestInput(init: { body?: string }): string[] {
    const body = JSON.parse(init.body ?? '{}') as unknown;
    assert.ok(isRecord(body));
    const input = body.input;
    assert.ok(Array.isArray(input));
    assert.ok(input.every((item) => typeof item === 'string'));
    return input;
  }

  it('sorts results by index field from API', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => ({
          data: [
            { embedding: [0.2, 0.2], index: 1 },
            { embedding: [0.1, 0.1], index: 0 },
          ],
        }),
      }),
    );

    const result = await embed(['first', 'second'], 'document');
    assert.equal(result.length, 2);
    const first = result[0]!;
    const second = result[1]!;
    assert.ok(first instanceof Float32Array);
    assert.ok(second instanceof Float32Array);
    // After sorting by index, first result should have embedding [0.1, 0.1]
    assert.ok(Math.abs(first[0]! - 0.1) < 0.001);
    assert.ok(Math.abs(second[0]! - 0.2) < 0.001);
  });

  it('falls back to per-item requests when batch response is missing an embedding', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init: { body?: string }) => {
      const input = requestInput(init);
      if (input.length === 2) {
        return {
          ok: true,
          status: 200,
          json: () => ({ data: [{ embedding: [0.1, 0.1], index: 0 }] }),
        };
      }

      return {
        ok: true,
        status: 200,
        json: () => ({
          data: [{ embedding: input[0] === 'first' ? [0.3, 0.3] : [0.4, 0.4], index: 0 }],
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await embed(['first', 'second'], 'document');

    assert.equal(fetchMock.mock.calls.length, 3);
    assert.equal(result.length, 2);
    assert.ok(result[0] instanceof Float32Array);
    assert.ok(result[1] instanceof Float32Array);
    assert.ok(Math.abs(result[0][0]! - 0.3) < 0.001);
    assert.ok(Math.abs(result[1][0]! - 0.4) < 0.001);
  });

  it('falls back to per-item requests when batch response has duplicate indexes', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init: { body?: string }) => {
      const input = requestInput(init);
      if (input.length === 2) {
        return {
          ok: true,
          status: 200,
          json: () => ({
            data: [
              { embedding: [0.1, 0.1], index: 0 },
              { embedding: [0.2, 0.2], index: 0 },
            ],
          }),
        };
      }

      return {
        ok: true,
        status: 200,
        json: () => ({
          data: [{ embedding: input[0] === 'first' ? [0.3, 0.3] : [0.4, 0.4], index: 0 }],
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await embed(['first', 'second'], 'document');

    assert.equal(fetchMock.mock.calls.length, 3);
    assert.ok(result[0] instanceof Float32Array);
    assert.ok(result[1] instanceof Float32Array);
    assert.ok(Math.abs(result[0][0]! - 0.3) < 0.001);
    assert.ok(Math.abs(result[1][0]! - 0.4) < 0.001);
  });

  it('falls back to per-item requests when batch response has an out-of-range index', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init: { body?: string }) => {
      const input = requestInput(init);
      if (input.length === 2) {
        return {
          ok: true,
          status: 200,
          json: () => ({
            data: [
              { embedding: [0.1, 0.1], index: 0 },
              { embedding: [0.2, 0.2], index: 2 },
            ],
          }),
        };
      }

      return {
        ok: true,
        status: 200,
        json: () => ({
          data: [{ embedding: input[0] === 'first' ? [0.3, 0.3] : [0.4, 0.4], index: 0 }],
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await embed(['first', 'second'], 'document');

    assert.equal(fetchMock.mock.calls.length, 3);
    assert.ok(result[0] instanceof Float32Array);
    assert.ok(result[1] instanceof Float32Array);
    assert.ok(Math.abs(result[0][0]! - 0.3) < 0.001);
    assert.ok(Math.abs(result[1][0]! - 0.4) < 0.001);
  });
});
