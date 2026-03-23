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

const { embed, LOCAL_MODEL } = await import('../src/embedder.js');

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
        json: async () => ({ data: [{ embedding: fakeEmbedding, index: 0 }] }),
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
      vi.fn().mockImplementation(async (_url: string, opts: { body: string }) => {
        capturedBody = JSON.parse(opts.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ embedding: fakeEmbedding, index: 0 }] }),
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
        text: async () => 'bad request',
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
      vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount < 2) {
          return { ok: false, status: 429, text: async () => 'rate limited' };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ embedding: fakeEmbedding, index: 0 }] }),
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
        text: async () => 'rate limited',
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
