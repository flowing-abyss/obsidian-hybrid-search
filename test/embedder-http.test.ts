import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, it, vi } from 'vitest';

const vaultDir = mkdtempSync(path.join(tmpdir(), 'ohs-provider-http-'));
const requests: { model: string; input: string[] }[] = [];
let invalidIndex = false;

function vector(text: string): number[] {
  const result = Array<number>(3072).fill(0);
  result[text.toLowerCase().includes('saffron') ? 0 : 1] = 1;
  return result;
}

const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/v1/models/gemini-embedding-2') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ context_length: 8192 }));
    return;
  }
  const buffers: Buffer[] = [];
  request.on('data', (buffer: Buffer) => buffers.push(buffer));
  request.on('end', () => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/embeddings');
      const body = JSON.parse(Buffer.concat(buffers).toString()) as {
        model: string;
        input: string[];
      };
      assert.equal(body.model, 'gemini-embedding-2');
      assert.ok(Array.isArray(body.input) && body.input.every((item) => typeof item === 'string'));
      requests.push(body);
      const data = body.input.map((text) => ({
        object: 'embedding',
        embedding: vector(text),
        ...(invalidIndex ? { index: null } : {}),
      }));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ object: 'list', data }));
    } catch (error) {
      response.writeHead(400, { 'content-type': 'text/plain' });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
});

server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
if (!address || typeof address === 'string') throw new Error('HTTP fixture did not bind TCP');
vi.stubEnv('OBSIDIAN_VAULT_PATH', vaultDir);
vi.stubEnv('OBSIDIAN_IGNORE_PATTERNS', '');
vi.stubEnv('OBSIDIAN_INCLUDE_PATTERNS', '');
vi.stubEnv('OBSIDIAN_RESPECT_GITIGNORE', 'false');
vi.stubEnv('OPENAI_BASE_URL', `http://127.0.0.1:${address.port}/v1`);
vi.stubEnv('OPENAI_API_KEY', 'fixture-only');
vi.stubEnv('OPENAI_EMBEDDING_MODEL', 'gemini-embedding-2');

const { embedDetailed, getEmbeddingDim, primeEmbeddingDim, clearOllamaSemaphore } =
  await import('../src/inference/embedder.js');
const { openDb, closeDb, initVecTable, getStoredEmbeddingDim, getStats } =
  await import('./helpers/owned-storage.js');
const { indexVaultSync } = await import('./helpers/owned-indexer.js');
const { search } = await import('../src/search/searcher.js');

afterAll(async () => {
  closeDb();
  clearOllamaSemaphore();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
  vi.unstubAllEnvs();
  rmSync(vaultDir, { recursive: true, force: true });
});

it('discovers dimensions, indexes and searches with an indexless HTTP provider', async () => {
  primeEmbeddingDim(4);
  assert.equal(await getEmbeddingDim({ refresh: true }), 3072);
  assert.deepEqual(
    requests.map((request) => request.input),
    [['dimension probe']],
  );

  const beforeBatch = requests.length;
  const batch = await embedDetailed(['Saffron', 'Cobalt']);
  assert.equal(requests.length - beforeBatch, 1);
  assert.equal(batch.length, 2);
  const first = batch[0];
  const second = batch[1];
  assert.ok(first?.ok && second?.ok);
  assert.equal(first.embedding.length, 3072);
  assert.equal(second.embedding.length, 3072);
  assert.deepEqual([...first.embedding.slice(0, 2)], [1, 0]);
  assert.deepEqual([...second.embedding.slice(0, 2)], [0, 1]);

  writeFileSync(
    path.join(vaultDir, 'saffron.md'),
    '# Saffron\n\nSaffron is a spice used in cooking and gives food a golden colour.\n',
  );
  writeFileSync(
    path.join(vaultDir, 'cobalt.md'),
    '# Cobalt\n\nCobalt is a blue pigment used to colour glass and ceramic materials.\n',
  );
  openDb();
  initVecTable(await getEmbeddingDim());
  const indexed = await indexVaultSync();
  assert.equal(indexed.indexed, 2);
  assert.deepEqual(indexed.errors, []);
  assert.equal(getStoredEmbeddingDim(), 3072);
  assert.equal(getStats().failedChunks, 0);
  const queries: [string, string][] = [
    ['Saffron', 'saffron.md'],
    ['Cobalt', 'cobalt.md'],
  ];
  for (const [query, expectedPath] of queries) {
    const results = await search(query, { mode: 'semantic', limit: 1, rerank: false });
    assert.equal(results[0]?.path, expectedPath);
  }

  const beforeSkip = requests.length;
  const unchanged = await indexVaultSync();
  assert.equal(unchanged.skipped, 2);
  assert.equal(requests.length, beforeSkip);

  invalidIndex = true;
  await assert.rejects(getEmbeddingDim({ refresh: true }), /dimension probe failed/);
  assert.equal(requests.length, beforeSkip + 1);
  assert.equal(await getEmbeddingDim(), 3072);
  assert.equal(getStoredEmbeddingDim(), 3072);
  assert.equal(getStats().indexed, 2);
  invalidIndex = false;
});
