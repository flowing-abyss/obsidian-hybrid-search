import assert from 'node:assert/strict';
import { getEventListeners, once } from 'node:events';
import { createServer, type RequestListener, type ServerResponse } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import type { TimerOptions } from 'node:timers';
import timers from 'node:timers/promises';
import { afterEach, beforeEach, it, vi } from 'vitest';

beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

async function withProvider(
  handler: RequestListener,
  operation: (base: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await operation(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function embeddingClient(base: string, ollama = false) {
  vi.stubEnv('OPENAI_BASE_URL', `${base}${ollama ? '/ollama' : ''}/v1`);
  vi.stubEnv('OPENAI_API_KEY', 'fixture-only');
  vi.stubEnv('OPENAI_EMBEDDING_MODEL', 'fixture-model');
  return import('../src/inference/embedder.js');
}

for (const provider of ['compatible', 'native', 'fallback'] as const) {
  for (const outcome of ['success', 'rejected', 'invalid-json'] as const) {
    it(`releases completed ${provider} request listeners after ${outcome}`, async () => {
      let requests = 0;
      await withProvider(
        (request, response) => {
          requests++;
          request.resume();
          const native = request.url?.endsWith('/api/embed');
          if (provider === 'fallback' && native) {
            response.writeHead(404).end('not supported');
          } else if (outcome === 'rejected') {
            response.writeHead(400).end('{"error":{"message":"rejected"}}');
          } else if (outcome === 'invalid-json') {
            response.end('{broken');
          } else {
            response.end(
              native ? '{"embeddings":[[1,0]]}' : '{"data":[{"index":0,"embedding":[1,0]}]}',
            );
          }
        },
        async (base) => {
          const { embedDetailed } = await embeddingClient(base, provider !== 'compatible');
          const controller = new AbortController();
          for (let index = 0; index < 8; index++) {
            const result = await embedDetailed(['note'], 'document', {
              signal: controller.signal,
            });
            assert.equal(result[0]?.ok, outcome === 'success');
            assert.equal(
              getEventListeners(controller.signal, 'abort').length,
              0,
              'completed requests must release the owner signal without GC or cancellation',
            );
            assert.equal(controller.signal.aborted, false);
          }
          assert.equal(requests, provider === 'fallback' ? 16 : 8);
        },
      );
    });
  }
}

it('shares bounded cancellation across concurrent requests until their bodies are consumed', async () => {
  const pending: ServerResponse[] = [];
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  await withProvider(
    (request, response) => {
      request.resume();
      response.write('{"data":[');
      pending.push(response);
      if (pending.length === 16) markStarted();
    },
    async (base) => {
      const { embedDetailed } = await embeddingClient(base);
      const controller = new AbortController();
      const work = Array.from({ length: 16 }, () =>
        embedDetailed(['note'], 'document', { signal: controller.signal }),
      );
      await started;
      const activeListeners = getEventListeners(controller.signal, 'abort').length;
      for (const response of pending) response.end('{"index":0,"embedding":[1,0]}]}');
      const results = await Promise.all(work);
      assert.ok(results.every((result) => result[0]?.ok));
      assert.ok(activeListeners <= 1);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    },
  );
});

it('cancels a streamed embedding body with the owner reason and no retries', async () => {
  let requests = 0;
  let markStarted!: () => void;
  let markClosed!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  await withProvider(
    (request, response) => {
      requests++;
      request.resume();
      response.on('close', markClosed);
      response.write('{"data":[');
      markStarted();
    },
    async (base) => {
      const { embedDetailed } = await embeddingClient(base);
      const controller = new AbortController();
      const reason = new Error('ownership transferred');
      const operation = embedDetailed(['note'], 'document', { signal: controller.signal });
      await started;
      controller.abort(reason);
      await assert.rejects(operation, (error) => error === reason);
      await closed;
      assert.equal(requests, 1);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    },
  );
});

it('releases an unread native response after compatible fallback succeeds', async () => {
  let markClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  await withProvider(
    (request, response) => {
      request.resume();
      if (request.url?.endsWith('/api/embed')) {
        response.on('close', markClosed);
        response.writeHead(404).write('unsupported');
      } else {
        response.end('{"data":[{"index":0,"embedding":[1,0]}]}');
      }
    },
    async (base) => {
      const { embedDetailed } = await embeddingClient(base, true);
      const controller = new AbortController();
      const result = await embedDetailed(['note'], 'document', { signal: controller.signal });
      assert.equal(result[0]?.ok, true);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      await closed;
      assert.equal(controller.signal.aborted, false);
    },
  );
});

it('bounds cancellation for queued Ollama requests and cancels the entire queue', async () => {
  let requests = 0;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  await withProvider(
    (request, response) => {
      requests++;
      request.resume();
      response.write('{"embeddings":[');
      markStarted();
    },
    async (base) => {
      const { embedDetailed } = await embeddingClient(base, true);
      const controller = new AbortController();
      controller.signal.addEventListener('abort', () => {}, { once: true });
      const reason = new Error('queued owner stopped');
      const work = Promise.allSettled(
        Array.from({ length: 16 }, () =>
          embedDetailed(['note'], 'document', { signal: controller.signal }),
        ),
      );
      await started;
      const activeListeners = getEventListeners(controller.signal, 'abort').length;
      controller.abort(reason);
      const results = await work;
      assert.ok(
        results.every((result) => result.status === 'rejected' && result.reason === reason),
      );
      assert.equal(requests, 1, 'cancelled queued requests must never be sent');
      assert.ok(activeListeners <= 2, 'queueing must share one owner listener');
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    },
  );
});

it('bounds cancellation during concurrent retry waits and cancels without another request', async () => {
  let waits = 0;
  let markWaiting!: () => void;
  const waiting = new Promise<void>((resolve) => {
    markWaiting = resolve;
  });
  const realDelay = timers.setTimeout;
  vi.spyOn(timers, 'setTimeout').mockImplementation(
    <T = void>(milliseconds?: number, value?: T, options?: TimerOptions) => {
      const result = realDelay(milliseconds, value, options);
      if (++waits === 16) markWaiting();
      return result;
    },
  );
  syncBuiltinESMExports();
  let requests = 0;
  await withProvider(
    (request, response) => {
      requests++;
      request.resume();
      response.writeHead(503).end('{"error":{"message":"temporarily unavailable"}}');
    },
    async (base) => {
      const { embedDetailed } = await embeddingClient(base);
      const controller = new AbortController();
      controller.signal.addEventListener('abort', () => {}, { once: true });
      const reason = new Error('retrying owner stopped');
      const work = Promise.allSettled(
        Array.from({ length: 16 }, () =>
          embedDetailed(['note'], 'document', { signal: controller.signal }),
        ),
      );
      await waiting;
      const activeListeners = getEventListeners(controller.signal, 'abort').length;
      controller.abort(reason);
      const results = await work;
      assert.ok(
        results.every(
          (result) =>
            result.status === 'rejected' &&
            result.reason instanceof Error &&
            result.reason.cause === reason,
        ),
      );
      assert.equal(requests, 16);
      assert.ok(activeListeners <= 2, 'retry delays must share one owner listener');
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    },
  );
});
