import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type RequestListener } from 'node:http';
import { afterEach, beforeEach, it, vi } from 'vitest';

vi.mock('node:timers/promises', () => ({ setTimeout: () => Promise.resolve() }));

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllEnvs());

async function withProvider(handler: RequestListener, operation: (base: string) => Promise<void>) {
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

async function client(base: string, ollama = false) {
  vi.stubEnv('OPENAI_BASE_URL', `${base}${ollama ? '/ollama' : ''}/v1`);
  vi.stubEnv('OPENAI_API_KEY', 'fixture-only');
  vi.stubEnv('OPENAI_EMBEDDING_MODEL', 'slow-fixture-model');
  vi.stubEnv('OBSIDIAN_EMBEDDING_TIMEOUT_MS', '100');
  return import('../src/inference/embedder.js');
}

for (const ollama of [false, true]) {
  it(`times out a stalled ${ollama ? 'native' : 'compatible'} response body, bounds retries and recovers`, async () => {
    let requests = 0;
    const closed: Promise<void>[] = [];
    await withProvider(
      (request, response) => {
        request.resume();
        if (++requests <= 3) {
          closed.push(new Promise<void>((resolve) => response.once('close', resolve)));
          response.write(ollama ? '{"embeddings":[' : '{"data":[');
        } else {
          response.end(
            ollama ? '{"embeddings":[[1,0]]}' : '{"data":[{"index":0,"embedding":[1,0]}]}',
          );
        }
      },
      async (base) => {
        const { embedDetailed } = await client(base, ollama);
        const outcomes = await embedDetailed(['note'], 'document');
        assert.equal(outcomes[0]?.ok, false);
        if (outcomes[0]?.ok === false) {
          assert.equal(outcomes[0].kind, 'transient');
          assert.match(outcomes[0].message, /timed out after 100 ms/);
        }
        assert.equal(requests, 3);
        await Promise.all(closed);
        assert.equal((await embedDetailed(['next note'], 'document'))[0]?.ok, true);
      },
    );
  });
}

it('falls back after stalled model discovery and caches the failed discovery', async () => {
  let requests = 0;
  await withProvider(
    (request, response) => {
      requests++;
      request.resume();
      response.write('{"context_length":');
    },
    async (base) => {
      const { getContextLength } = await client(base);
      assert.equal(await getContextLength(1234), 1234);
      assert.equal(await getContextLength(4321), 4321);
      assert.equal(requests, 1);
    },
  );
});

it.each(['0', '-1', 'NaN', '1.5', '600001', ''])(
  'rejects an invalid provider timeout: %s',
  async (value) => {
    const { embedDetailed } = await client('http://127.0.0.1:1');
    vi.stubEnv('OBSIDIAN_EMBEDDING_TIMEOUT_MS', value);
    await assert.rejects(embedDetailed(['note']), /OBSIDIAN_EMBEDDING_TIMEOUT_MS/);
  },
);
