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

const { embed, embedDetailed, getContextLength, clearOllamaSemaphore } =
  await import('../src/embedder.js');

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

function providerErrorResponse(
  status: number,
  error: {
    code?: string | number;
    type?: string;
    message?: string;
    metadata?: { error_type?: string };
  },
): { ok: boolean; status: number; text: () => Promise<string>; json: () => unknown } {
  const body = { error };
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => body,
  };
}

describe('embedDetailed() — structured provider outcomes', () => {
  const fakeEmb = Array.from({ length: 384 }, () => 0.1);

  it('classifies OpenRouter HTTP 200 context metadata without transient sleeps', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      providerErrorResponse(200, {
        code: 400,
        message: "HTTP 400: Invalid 'input[0]': maximum input length is 8192 tokens.",
        metadata: { error_type: 'context_length_exceeded' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const [outcome] = await embedDetailed(['oversized'], 'document');

    assert.ok(outcome && !outcome.ok);
    assert.equal(outcome.kind, 'input_too_long');
    assert.equal(outcome.status, 200);
    assert.equal(outcome.providerCode, 400);
    assert.match(outcome.message, /maximum input length/i);
    assert.equal(fetchMock.mock.calls.length, 1);
    assert.equal(timeoutSpy.mock.calls.length, 0);
  });

  it('classifies a generic structured HTTP 400 as permanent', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      providerErrorResponse(400, {
        code: 'invalid_request_error',
        type: 'invalid_request_error',
        message: 'Invalid dimensions parameter',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const [outcome] = await embedDetailed(['text'], 'document');

    assert.ok(outcome && !outcome.ok);
    assert.equal(outcome.kind, 'permanent');
    assert.equal(outcome.status, 400);
    assert.equal(outcome.providerCode, 'invalid_request_error');
    assert.equal(fetchMock.mock.calls.length, 1);
  });

  for (const scenario of [
    { name: 'network error', response: new Error('socket closed') },
    { name: 'HTTP 429', response: providerErrorResponse(429, { message: 'rate limited' }) },
    { name: 'HTTP 502', response: providerErrorResponse(502, { message: 'bad gateway' }) },
  ]) {
    it(`retries a failed batch exactly twice without per-item fanout for ${scenario.name}`, async () => {
      const fetchMock =
        scenario.response instanceof Error
          ? vi.fn().mockRejectedValue(scenario.response)
          : vi.fn().mockResolvedValue(scenario.response);
      vi.stubGlobal('fetch', fetchMock);
      vi.useFakeTimers();

      const outcomePromise = embedDetailed(['first', 'second'], 'document');
      await vi.runAllTimersAsync();
      const outcomes = await outcomePromise;

      assert.equal(fetchMock.mock.calls.length, 3);
      for (const [, init] of fetchMock.mock.calls) {
        const body = JSON.parse((init as { body: string }).body) as { input: string[] };
        assert.equal(body.input.length, 2);
      }
      assert.equal(outcomes.length, 2);
      assert.ok(outcomes.every((outcome) => !outcome.ok && outcome.kind === 'transient'));
    });
  }

  it('localizes an unidentified batch context error with singleton requests', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init: { body: string }) => {
      const { input } = JSON.parse(init.body) as { input: string[] };
      if (input.length > 1 || input[0] === 'oversized') {
        return Promise.resolve(
          providerErrorResponse(400, {
            message: 'maximum input length exceeded for this embedding model',
          }),
        );
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => ({ data: [{ embedding: fakeEmb, index: 0 }] }),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const outcomes = await embedDetailed(['fits', 'oversized'], 'document');

    assert.equal(fetchMock.mock.calls.length, 3);
    assert.ok(outcomes[0]?.ok);
    assert.ok(outcomes[0].embedding instanceof Float32Array);
    assert.ok(outcomes[1] && !outcomes[1].ok);
    assert.equal(outcomes[1].kind, 'input_too_long');
    assert.deepEqual(
      fetchMock.mock.calls.map(([, init]) => {
        const body = JSON.parse((init as { body: string }).body) as { input: string[] };
        return body.input.length;
      }),
      [2, 1, 1],
    );
  });

  it('uses an HTTP 200 numeric provider code for bounded transient retries', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(providerErrorResponse(200, { code: 429, message: 'rate limited' }));
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();

    const outcomePromise = embedDetailed(['first', 'second'], 'document');
    await vi.runAllTimersAsync();
    const outcomes = await outcomePromise;

    assert.equal(fetchMock.mock.calls.length, 3);
    assert.ok(
      outcomes.every(
        (outcome) =>
          !outcome.ok &&
          outcome.kind === 'transient' &&
          outcome.status === 200 &&
          outcome.providerCode === 429,
      ),
    );
  });

  it('retries a generic HTTP 520 exactly twice without singleton fanout', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(providerErrorResponse(520, { message: 'provider unavailable' }));
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();

    const outcomePromise = embedDetailed(['first', 'second'], 'document');
    await vi.runAllTimersAsync();
    const outcomes = await outcomePromise;

    assert.equal(fetchMock.mock.calls.length, 3);
    assert.ok(
      outcomes.every(
        (outcome) => !outcome.ok && outcome.kind === 'transient' && outcome.status === 520,
      ),
    );
    for (const [, init] of fetchMock.mock.calls) {
      const body = JSON.parse((init as { body: string }).body) as { input: string[] };
      assert.equal(body.input.length, 2);
    }
  });

  it('retries HTTP 408 exactly twice without singleton fanout', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(providerErrorResponse(408, { message: 'request timeout' }));
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();

    const outcomePromise = embedDetailed(['first', 'second'], 'document');
    await vi.runAllTimersAsync();
    const outcomes = await outcomePromise;

    assert.equal(fetchMock.mock.calls.length, 3);
    assert.ok(outcomes.every((outcome) => !outcome.ok && outcome.kind === 'transient'));
    for (const [, init] of fetchMock.mock.calls) {
      const body = JSON.parse((init as { body: string }).body) as { input: string[] };
      assert.equal(body.input.length, 2);
    }
  });

  it('returns positional invalid responses for malformed JSON and maps them to public nulls', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('Unexpected token')),
    });
    vi.stubGlobal('fetch', fetchMock);

    const outcomes = await embedDetailed(['first', 'second'], 'document');
    const publicResults = await embed(['first', 'second'], 'document');

    assert.equal(fetchMock.mock.calls.length, 2);
    assert.ok(outcomes.every((outcome) => !outcome.ok && outcome.kind === 'invalid_response'));
    assert.deepEqual(publicResults, [null, null]);
  });

  it('handles an unreadable error body as positional invalid responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.reject(new Error('body stream failed')),
    });
    vi.stubGlobal('fetch', fetchMock);

    const outcomes = await embedDetailed(['first', 'second'], 'document');

    assert.equal(fetchMock.mock.calls.length, 1);
    assert.ok(outcomes.every((outcome) => !outcome.ok && outcome.kind === 'invalid_response'));
  });

  it('retries an unreadable body when its HTTP status is transient', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      text: () => Promise.reject(new Error('body stream failed')),
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();

    const outcomePromise = embedDetailed(['first', 'second'], 'document');
    await vi.runAllTimersAsync();
    const outcomes = await outcomePromise;

    assert.equal(fetchMock.mock.calls.length, 3);
    assert.ok(outcomes.every((outcome) => !outcome.ok && outcome.kind === 'transient'));
  });

  for (const scenario of [
    {
      name: 'schema',
      response: { data: [{ embedding: ['bad'], index: 0 }] },
    },
    {
      name: 'index',
      response: { data: [{ embedding: [0.1], index: 9 }] },
    },
    {
      name: 'cardinality',
      response: { data: [] },
    },
  ]) {
    it(`localizes ${scenario.name} failures and exposes invalid_response outcomes`, async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => scenario.response,
      });
      vi.stubGlobal('fetch', fetchMock);

      const outcomes = await embedDetailed(['first', 'second'], 'document');

      assert.equal(fetchMock.mock.calls.length, 3);
      assert.ok(outcomes.every((outcome) => !outcome.ok && outcome.kind === 'invalid_response'));
    });
  }
});

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

  it('retries a transient batch without singleton fanout', async () => {
    const requestSizes: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as { input: string[] };
        requestSizes.push(body.input.length);
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
    assert.deepEqual(result, [null, null]);
    assert.deepEqual(requestSizes, [2, 2, 2]);
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

  for (const baseUrl of [
    'http://localhost:11434',
    'http://localhost:11434/',
    'http://localhost:11434/v1',
    'http://localhost:11434/v1/',
  ]) {
    it(`normalizes ${baseUrl} to native embed with truncation disabled`, async () => {
      process.env.OPENAI_BASE_URL = baseUrl;
      process.env.OPENAI_EMBEDDING_MODEL = 'bge-m3:latest';
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => ({ embeddings: [[0.1, 0.2]] }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const [embedding] = await embed(['text'], 'document');

      assert.ok(embedding instanceof Float32Array);
      assert.equal(fetchMock.mock.calls[0]?.[0], 'http://localhost:11434/api/embed');
      const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body) as {
        model: string;
        input: string[];
        truncate: boolean;
      };
      assert.deepEqual(body, { model: 'bge-m3:latest', input: ['text'], truncate: false });
    });
  }

  it('sends one native request per input and preserves positional results', async () => {
    const capturedBodies: string[][] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, opts: { body: string }) => {
        const body = JSON.parse(opts.body) as { input: string[] };
        capturedBodies.push(body.input);
        const value = body.input[0] === 'text1' ? 0.1 : body.input[0] === 'text2' ? 0.2 : 0.3;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => ({ embeddings: [[value, value]] }),
        });
      }),
    );
    const results = await embed(['text1', 'text2', 'text3'], 'document');
    for (const body of capturedBodies) {
      assert.equal(body.length, 1, `Ollama batch should be 1, got ${body.length}`);
    }
    assert.equal(capturedBodies.length, 3, 'should make 3 requests for 3 texts');
    assert.deepEqual(
      results.map((embedding) => (embedding ? Number(embedding[0]!.toFixed(1)) : undefined)),
      [0.1, 0.2, 0.3],
    );
  });

  for (const status of [404, 405]) {
    it(`falls back once to the compatible endpoint after native HTTP ${status}`, async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status,
          text: () => Promise.resolve(JSON.stringify({ error: 'not found' })),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => ({ data: [{ embedding: fakeEmb, index: 0 }] }),
        });
      vi.stubGlobal('fetch', fetchMock);

      const [outcome] = await embedDetailed(['text'], 'document');

      assert.ok(outcome?.ok);
      assert.deepEqual(
        fetchMock.mock.calls.map(([url]) => String(url)),
        ['http://localhost:11434/api/embed', 'http://localhost:11434/v1/embeddings'],
      );
    });
  }

  it('does not use the compatible endpoint for other native failures', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve(JSON.stringify({ error: 'invalid model' })),
    });
    vi.stubGlobal('fetch', fetchMock);

    const [outcome] = await embedDetailed(['text'], 'document');

    assert.ok(outcome && !outcome.ok);
    assert.equal(outcome.kind, 'permanent');
    assert.equal(fetchMock.mock.calls.length, 1);
    assert.equal(fetchMock.mock.calls[0]?.[0], 'http://localhost:11434/api/embed');
  });

  it('retries native 5xx failures without compatible endpoint calls', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 520,
      text: () => Promise.resolve(JSON.stringify({ error: 'provider unavailable' })),
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();

    const outcomePromise = embedDetailed(['text'], 'document');
    await vi.runAllTimersAsync();
    const [outcome] = await outcomePromise;

    assert.ok(outcome && !outcome.ok);
    assert.equal(outcome.kind, 'transient');
    assert.deepEqual(
      fetchMock.mock.calls.map(([url]) => String(url)),
      Array.from({ length: 3 }, () => 'http://localhost:11434/api/embed'),
    );
  });

  it('classifies a native context rejection as input_too_long', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () =>
          Promise.resolve(
            JSON.stringify({ error: 'input length exceeds the context token limit' }),
          ),
      }),
    );

    const [outcome] = await embedDetailed(['text'], 'document');

    assert.ok(outcome && !outcome.ok);
    assert.equal(outcome.kind, 'input_too_long');
  });

  it('uses the untagged model only for known context lookup', async () => {
    process.env.OPENAI_EMBEDDING_MODEL = 'bge-m3:latest';
    clearOllamaSemaphore();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    assert.equal(await getContextLength(), 8192);
    assert.equal(fetchMock.mock.calls.length, 0);
  });

  it('does not normalize model tags for non-Ollama context lookup', async () => {
    process.env.OPENAI_BASE_URL = 'https://api.test/v1';
    process.env.OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small:latest';
    clearOllamaSemaphore();
    const fetchMock = vi.fn().mockResolvedValue({
      json: () => ({ context_length: 1234 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    assert.equal(await getContextLength(), 1234);
    assert.equal(fetchMock.mock.calls.length, 1);
    assert.equal(
      fetchMock.mock.calls[0]?.[0],
      'https://api.test/v1/models/text-embedding-3-small:latest',
    );
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
