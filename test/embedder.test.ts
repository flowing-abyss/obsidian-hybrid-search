import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, it, vi } from 'vitest';

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

const { embed, LOCAL_MODEL, clearOllamaSemaphore } = await import('../src/embedder.js');

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

describe('embed() — batch failure falls back to per-item retry', () => {
  afterEach(() => vi.restoreAllMocks());

  it('retries each text individually when batch of 2 fails', async () => {
    const fakeEmbedding = new Array(384).fill(0.1);
    const batchSizes: number[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, opts: { body: string }) => {
        const body = JSON.parse(opts.body) as { input: string[] };
        batchSizes.push(body.input.length);
        if (body.input.length > 1) {
          return { ok: false, status: 500, text: () => 'server error' };
        }
        return {
          ok: true,
          status: 200,
          json: () => ({ data: [{ embedding: fakeEmbedding, index: 0 }] }),
        };
      }),
    );

    const result = await embed(['first text', 'second text'], 'document');
    assert.equal(result.length, 2);
    assert.ok(result[0] instanceof Float32Array);
    assert.ok(result[1] instanceof Float32Array);
    // First call is batch of 2, then two individual calls
    assert.deepEqual(batchSizes, [2, 1, 1]);
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
              json: () => ({ data: [{ embedding: fakeEmbedding, index: 0 }] }),
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
              json: () => ({ data: [{ embedding: fakeEmbedding, index: 0 }] }),
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
});

describe('embed() — batch sorting by index', () => {
  afterEach(() => vi.restoreAllMocks());

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
});
