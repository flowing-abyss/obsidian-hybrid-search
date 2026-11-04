import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, it, vi } from 'vitest';

const vault = mkdtempSync(path.join(tmpdir(), 'ohs-chunk-status-'));
process.env.OBSIDIAN_VAULT_PATH = vault;
const db = await import('./helpers/owned-storage.js');
const embedder = await import('../src/inference/embedder.js');
const policy = await import('../src/indexing/chunk-policy.js');
const { buildStatusPayload } = await import('../src/transports/status-payload.js');
const { createMcpRuntime, createMcpServer, closeMcpRuntime } =
  await import('../src/transports/mcp-runtime.js');

function seed(chunkTokens = 512) {
  db.initVecTable(4);
  db.upsertNote(
    {
      path: 'note.md',
      title: 'Note',
      tags: [],
      content: 'Searchable note',
      mtime: 1,
      hash: '1',
      chunks: [{ text: 'Searchable note', embedding: new Float32Array([1, 0, 0, 0]) }],
    },
    { modelName: 'fixture', chunkPolicy: { chunkTokens, contextLength: 8192 } },
  );
}

beforeEach(() => {
  vi.stubEnv('OBSIDIAN_CHUNK_TOKENS', undefined);
  vi.stubEnv('OBSIDIAN_CONTENT_IGNORE_PATTERNS', undefined);
  mkdirSync(vault, { recursive: true });
  db.openDb();
  vi.spyOn(embedder, 'activeModelName').mockReturnValue('fixture');
  vi.spyOn(embedder, 'getContextLength').mockResolvedValue(8192);
});
afterEach(() => {
  db.closeDb();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(vault, { recursive: true, force: true });
});

it('reports unknown chunk size on an empty index without a configuration notice', () => {
  const status = buildStatusPayload({ contextLength: 8192, version: 'test' });
  assert.equal(status.chunk_tokens, null);
  assert.equal(status.embedding_dim, null);
  assert.equal(status.context_length, 8192);
  assert.equal(policy.getChunkPolicyStatus(8192).notice, undefined);
});

it('reports only actual values and an actionable notice for a pending change', () => {
  seed();
  vi.stubEnv('OBSIDIAN_CHUNK_TOKENS', '1024');
  const status = buildStatusPayload({ contextLength: 8192, version: 'test' });
  assert.equal(status.embedding_dim, 4);
  assert.equal(status.context_length, 8192);
  assert.equal(status.chunk_tokens, 512);
  assert.deepEqual(
    Object.keys(status)
      .filter((key) => /chunk|context|dimension|_dim/.test(key))
      .sort((a, b) => a.localeCompare(b)),
    [
      'chunk_tokens',
      'chunks',
      'context_length',
      'embedding_dim',
      'failed_chunks',
      'notes_without_chunks',
    ],
  );
  assert.match(
    policy.getChunkPolicyStatus(8192).notice!,
    /512.*reindex --force.*1024.*OBSIDIAN_CHUNK_TOKENS/,
  );
});

it.each([undefined, '512'])('has no notice for unchanged configuration %s', (value) => {
  seed();
  vi.stubEnv('OBSIDIAN_CHUNK_TOKENS', value);
  assert.equal(policy.getChunkPolicyStatus(8192).notice, undefined);
});

it('compares the capped value and retains custom size when env is omitted', () => {
  seed(8192);
  vi.stubEnv('OBSIDIAN_CHUNK_TOKENS', '10000');
  assert.equal(policy.getChunkPolicyStatus(8192).notice, undefined);
  vi.stubEnv('OBSIDIAN_CHUNK_TOKENS', undefined);
  assert.equal(policy.getChunkPolicyStatus(8192).notice, undefined);
});

it('keeps actual size visible when env is invalid', () => {
  seed();
  vi.stubEnv('OBSIDIAN_CHUNK_TOKENS', 'broken');
  assert.equal(buildStatusPayload({ contextLength: 8192, version: 'test' }).chunk_tokens, 512);
  assert.match(
    policy.getChunkPolicyStatus(8192).notice!,
    /OBSIDIAN_CHUNK_TOKENS.*positive integer/,
  );
});

it.each(['missing', 'corrupt'])('keeps legacy/corrupt status readable: %s', (state) => {
  seed();
  if (state === 'missing')
    db.getDb().prepare("DELETE FROM settings WHERE key IN ('chunk_tokens','context_length')").run();
  else db.getDb().prepare("UPDATE settings SET value='bad' WHERE key='chunk_tokens'").run();
  const status = buildStatusPayload({ contextLength: 8192, version: 'test' });
  assert.equal(status.indexed, 1);
  assert.equal(status.embedding_dim, 4);
  assert.equal(status.chunk_tokens, null);
  assert.match(policy.getChunkPolicyStatus(8192).notice!, /reindex --force/);
});

it('uses saved context as fallback only for the matching model', async () => {
  seed();
  vi.mocked(embedder.getContextLength).mockImplementation((fallback) =>
    Promise.resolve(fallback ?? 512),
  );
  assert.equal(await policy.getIndexContextLength(), 8192);
  vi.mocked(embedder.activeModelName).mockReturnValue('other');
  assert.equal(await policy.getIndexContextLength(), 512);
});

it('MCP keeps the same numeric fields and reads published chunk size without restart', async () => {
  seed();
  const runtime = await createMcpRuntime();
  const server = createMcpServer(runtime);
  const client = new Client({ name: 'chunk-status', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    vi.stubEnv('OBSIDIAN_CHUNK_TOKENS', '1024');
    const read = async () => {
      const result = await client.callTool({ name: 'status', arguments: {} });
      assert.ok(!result.isError);
      const content = result.content as Array<{ type: string; text: string }>;
      const text = content[0]!.text;
      const end = text.lastIndexOf('}') + 1;
      return {
        status: JSON.parse(text.slice(0, end)) as Record<string, unknown>,
        hint: text.slice(end),
      };
    };
    const pending = await read();
    assert.equal(pending.status.embedding_dim, 4);
    assert.equal(pending.status.context_length, 8192);
    assert.equal(pending.status.chunk_tokens, 512);
    assert.match(pending.hint, /reindex --force/);
    db.getDb().prepare("UPDATE settings SET value='1024' WHERE key='chunk_tokens'").run();
    const applied = await read();
    assert.equal(applied.status.chunk_tokens, 1024);
    assert.equal(applied.hint, '');
  } finally {
    await client.close();
    await server.close();
    await closeMcpRuntime(runtime);
  }
});
