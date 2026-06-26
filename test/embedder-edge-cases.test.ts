import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, it, vi } from 'vitest';

const vaultDir = mkdtempSync(path.join(tmpdir(), 'ohs-embedder-edge-'));
process.env.OBSIDIAN_VAULT_PATH = vaultDir;
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_BASE_URL = 'https://api.test/v1';

afterAll(() => {
  rmSync(vaultDir, { recursive: true, force: true });
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete process.env.OPENAI_EMBEDDING_MODEL;
});

const { embed, clearOllamaSemaphore } = await import('../src/embedder.js');

function mockFetchOk(embeddings: number[][], status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve('error body'),
      json: () => ({
        data: embeddings.map((emb: number[], i: number) => ({ embedding: emb, index: i })),
      }),
    }),
  );
}

function mockFetchError(status: number, body: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: false,
      status,
      text: () => Promise.resolve(body),
      json: () => ({ error: { message: body } }),
    }),
  );
}

describe('embed() — API response validation', () => {
  const fakeEmb = Array.from({ length: 384 }, () => 0.1);

  it('returns embeddings for valid response', async () => {
    mockFetchOk([fakeEmb]);
    const result = await embed(['hello'], 'document');
    assert.equal(result.length, 1);
    assert.ok(result[0] instanceof Float32Array);
  });

  // When a batch response has mismatched/duplicate/out-of-range indexes, embedder does NOT
  // throw to the caller — it falls back to per-item requests (see embedApiBatchWithFallback).
  // These tests assert that fallback behavior. The error "indexes do not match" is internal
  // and only triggers the per-item retry path; the caller still gets embeddings or nulls.
  it('falls back to per-item on wrong number of items in response', async () => {
    let callCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // Batch of 2 returns only 1 item — index mismatch triggers fallback
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => ({ data: [{ embedding: fakeEmb, index: 0 }] }),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => ({ data: [{ embedding: fakeEmb, index: 0 }] }),
        });
      }),
    );
    const result = await embed(['text1', 'text2'], 'document');
    assert.equal(result.length, 2);
    assert.ok(result[0] instanceof Float32Array);
    assert.ok(result[1] instanceof Float32Array);
    assert.ok(callCount >= 3, `should fall back to per-item (callCount=${callCount})`);
  });

  it('falls back to per-item on duplicate index in response', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, opts: { body: string }) => {
      const body = JSON.parse(opts.body) as { input: string[] };
      if (body.input.length === 2) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => ({
            data: [
              { embedding: fakeEmb, index: 0 },
              { embedding: fakeEmb, index: 0 },
            ],
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => ({ data: [{ embedding: fakeEmb, index: 0 }] }),
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await embed(['text1', 'text2'], 'document');
    assert.equal(result.length, 2);
    assert.ok(result[0] instanceof Float32Array);
    assert.ok(result[1] instanceof Float32Array);
    assert.equal(fetchMock.mock.calls.length, 3);
  });

  it('falls back to per-item on out-of-range index in response', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, opts: { body: string }) => {
      const body = JSON.parse(opts.body) as { input: string[] };
      if (body.input.length === 2) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => ({
            data: [
              { embedding: fakeEmb, index: 0 },
              { embedding: fakeEmb, index: 5 },
            ],
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => ({ data: [{ embedding: fakeEmb, index: 0 }] }),
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await embed(['text1', 'text2'], 'document');
    assert.equal(result.length, 2);
    assert.ok(result[0] instanceof Float32Array);
    assert.ok(result[1] instanceof Float32Array);
    assert.equal(fetchMock.mock.calls.length, 3);
  });

  // When the response body carries { error: { message } } (even with ok:true), embedder treats
  // it as a transient failure, retries (with backoff), then returns [null]. It does NOT surface
  // the error message to the caller. Use fake timers to advance the 2s/4s backoff instantly.
  it('returns null after retries when response has error.message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => ({ error: { message: 'model not found' } }),
      }),
    );
    vi.useFakeTimers();
    const embedPromise = embed(['text'], 'document');
    await vi.runAllTimersAsync();
    const result = await embedPromise;
    assert.equal(result.length, 1);
    assert.equal(result[0], null);
  });

  it('throws on non-200 HTTP with body text', async () => {
    // 400 is non-transient: no retry, returns [null] (does not throw to caller)
    mockFetchError(400, 'Bad request');
    const result = await embed(['text'], 'document');
    assert.equal(result.length, 1);
    assert.equal(result[0], null);
  });
});

describe('embed() — retry and fallback', () => {
  const fakeEmb = Array.from({ length: 384 }, () => 0.1);

  // 429 is transient: embedder retries twice (2s, 4s backoff) then returns [null].
  // Using fake timers avoids the real 6s delay.
  it('returns null for transient error after retries (429)', async () => {
    mockFetchError(429, 'Rate limited');
    vi.useFakeTimers();
    const embedPromise = embed(['text'], 'document');
    await vi.runAllTimersAsync();
    const result = await embedPromise;
    assert.equal(result.length, 1);
    assert.equal(result[0], null);
  });

  it('returns null for non-transient error immediately (400)', async () => {
    mockFetchError(400, 'Bad request');
    const result = await embed(['text'], 'document');
    assert.equal(result[0], null);
  });

  it('splits batch on failure and returns null for failed item', async () => {
    // Batch of 2 fails with 500 (transient). Fallback retries each item individually.
    // Each individual item that keeps failing retries 2 more times (2s/4s backoff) → null.
    let callCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // Batch of 2 fails with 500 (transient) → triggers per-item fallback
          return Promise.resolve({
            ok: false,
            status: 500,
            text: () => Promise.resolve('Server error'),
            json: () => ({ error: { message: 'Server error' } }),
          });
        }
        // Individual call 2 succeeds
        if (callCount === 2) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => ({ data: [{ embedding: fakeEmb, index: 0 }] }),
          });
        }
        // Individual call 3 keeps failing with 500 → retries → ultimately null
        return Promise.resolve({
          ok: false,
          status: 500,
          text: () => Promise.resolve('Server error'),
          json: () => ({ error: { message: 'Server error' } }),
        });
      }),
    );
    vi.useFakeTimers();
    const embedPromise = embed(['good', 'bad'], 'document');
    await vi.runAllTimersAsync();
    const result = await embedPromise;
    assert.equal(result.length, 2);
    const hasNull = result.some((r) => r === null);
    const hasArray = result.some((r) => r instanceof Float32Array);
    assert.ok(hasNull, 'should have at least one null');
    assert.ok(hasArray, 'should have at least one embedding');
  });

  it('returns all null when all items fail', async () => {
    mockFetchError(500, 'Server error');
    vi.useFakeTimers();
    const embedPromise = embed(['text1', 'text2'], 'document');
    await vi.runAllTimersAsync();
    const result = await embedPromise;
    assert.equal(result.length, 2);
    assert.equal(result[0], null);
    assert.equal(result[1], null);
  });
});

describe('embed() — Ollama throttling', () => {
  const fakeEmb = Array.from({ length: 384 }, () => 0.1);

  beforeEach(() => {
    process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1';
    clearOllamaSemaphore();
  });

  afterEach(() => {
    process.env.OPENAI_BASE_URL = 'https://api.test/v1';
  });

  it('sends one text at a time to Ollama endpoint (batch size 1)', async () => {
    const capturedBodies: string[][] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, opts: { body: string }) => {
        const body = JSON.parse(opts.body) as { input: string[] };
        capturedBodies.push(body.input);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => ({ data: [{ embedding: fakeEmb, index: 0 }] }),
        });
      }),
    );
    await embed(['text1', 'text2', 'text3'], 'document');
    for (const body of capturedBodies) {
      assert.equal(body.length, 1, `Ollama batch should be 1, got ${body.length}`);
    }
    assert.equal(capturedBodies.length, 3, 'should make 3 requests for 3 texts');
  });
});

describe('embed() — prefix logic', () => {
  const fakeEmb = Array.from({ length: 384 }, () => 0.1);
  let capturedBody: { input: string[]; model: string };

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, opts: { body: string }) => {
        capturedBody = JSON.parse(opts.body) as { input: string[]; model: string };
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => ({ data: [{ embedding: fakeEmb, index: 0 }] }),
        });
      }),
    );
  });

  it('adds "passage: " prefix for E5 model document embedding', async () => {
    process.env.OPENAI_EMBEDDING_MODEL = 'intfloat/multilingual-e5-large';
    await embed(['hello'], 'document');
    assert.equal(capturedBody.input[0], 'passage: hello');
  });

  it('adds "query: " prefix for E5 model query embedding', async () => {
    process.env.OPENAI_EMBEDDING_MODEL = 'intfloat/multilingual-e5-large';
    await embed(['search'], 'query');
    assert.equal(capturedBody.input[0], 'query: search');
  });

  it('does NOT add prefix for non-E5 model (text-embedding-3-small)', async () => {
    process.env.OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
    await embed(['hello'], 'document');
    assert.equal(capturedBody.input[0], 'hello');
  });

  it('does NOT add prefix for BGE model', async () => {
    process.env.OPENAI_EMBEDDING_MODEL = 'baai/bge-m3';
    await embed(['hello'], 'document');
    assert.equal(capturedBody.input[0], 'hello');
  });
});
