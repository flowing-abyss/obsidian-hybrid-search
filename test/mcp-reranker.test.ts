import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import type { RerankCandidate } from '../src/reranker.js';

let directory: string;
let closeRuntime: (() => Promise<void>) | undefined;

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'ohs-mcp-reranker-'));
  const vault = path.join(directory, 'vault');
  mkdirSync(vault);
  vi.stubEnv('OBSIDIAN_VAULT_PATH', vault);
  vi.stubEnv('XDG_CACHE_HOME', path.join(directory, 'cache'));
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('RERANKER_MODEL', 'onnx-community/gte-multilingual-reranker-base');
  vi.stubEnv('OBSIDIAN_PREFIX', '');
});

afterEach(async () => {
  try {
    await closeRuntime?.();
  } finally {
    closeRuntime = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
});

type GpuMode = 'healthy' | 'absent' | 'load-error' | 'score-error' | 'invalid';
interface Results {
  results: Array<{ path: string; score: number }>;
}

async function startRuntime(mode: GpuMode, transport: 'memory' | 'http') {
  // A fresh module graph recreates CLI/MCP singletons while retaining disk state.
  vi.resetModules();
  const embedder = await import('../src/embedder.js');
  vi.spyOn(embedder, 'embed').mockImplementation((texts) =>
    Promise.resolve(texts.map(() => new Float32Array([1, 0, 0, 0]))),
  );
  vi.spyOn(embedder, 'getContextLength').mockResolvedValue(512);
  const { RerankerGpu } = await import('../src/reranker-gpu.js');
  const probe = vi.spyOn(RerankerGpu.prototype, 'probe').mockResolvedValue(mode !== 'absent');
  const load = vi
    .spyOn(RerankerGpu.prototype, 'load')
    .mockImplementation(() =>
      mode === 'load-error' ? Promise.reject(new Error('GPU load failed')) : Promise.resolve(),
    );
  const score = vi.spyOn(RerankerGpu.prototype, 'scoreAll').mockImplementation((_q, candidates) => {
    if (mode === 'score-error') return Promise.reject(new Error('GPU inference failed'));
    return Promise.resolve(
      candidates.map((c: RerankCandidate) =>
        mode === 'invalid' ? Number.NaN : c.title === 'Reference Z' ? 8 : -8,
      ),
    );
  });
  vi.spyOn(RerankerGpu.prototype, 'close').mockResolvedValue();
  const model = await import('../src/reranker-model.js');
  const cpu = vi.fn<
    (
      inputs: Array<{ text_pair: string }>,
    ) => Promise<Array<Array<{ label: string; score: number }>>>
  >((inputs) =>
    Promise.resolve(
      inputs.map((input) => [
        {
          label: 'LABEL_1',
          score: input.text_pair.startsWith('Reference Z\n') ? 5 : -5,
        },
      ]),
    ),
  );
  vi.spyOn(model, 'loadRerankerModel').mockResolvedValue(cpu);
  const db = await import('../src/db.js');
  const client = new Client({ name: 'reranker-regression', version: '1.0.0' });
  let closeServer = () => Promise.resolve();
  closeRuntime = async () => {
    try {
      await client.close();
    } finally {
      try {
        await closeServer();
      } finally {
        db.closeDb();
      }
    }
  };
  db.openDb();
  db.initVecTable(4);
  // Five tied retrieval candidates leave enough room for reranking to change the top two.
  for (const suffix of ['a', 'b', 'c', 'd', 'e']) {
    const content = 'Internal links connect notes in a knowledge base.';
    writeFileSync(path.join(process.env.OBSIDIAN_VAULT_PATH!, `${suffix}.md`), content);
    db.upsertNote({
      path: `${suffix}.md`,
      title: `Reference ${suffix === 'b' ? 'Z' : suffix.toUpperCase()}`,
      tags: [],
      content,
      mtime: 1,
      hash: suffix,
      chunks: [{ text: content, embedding: new Float32Array([1, 0, 0, 0]) }],
    });
  }
  const { createMcpRuntime, createMcpServer } = await import('../src/mcp-runtime.js');
  if (transport === 'http') {
    const { runHttpMcpServer } = await import('../src/mcp-http-server.js');
    const server = await runHttpMcpServer({ host: '127.0.0.1', port: 0 });
    closeServer = () => server.close();
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
  } else {
    const server = createMcpServer(await createMcpRuntime());
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeServer = () => server.close();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  }
  return { client, probe, load, score, cpu };
}

async function search(client: Client, query = 'internal links', rerank = true): Promise<Results> {
  const response = await client.callTool(
    { name: 'search', arguments: { query, rerank, limit: 2 } },
    undefined,
    { timeout: 5000 },
  );
  assert.ok(!response.isError, 'reranking failures must not become MCP tool errors');
  const content = response.content as Array<{ type: string; text: string }>;
  assert.equal(content.length, 1);
  assert.equal(content[0]?.type, 'text');
  const result = JSON.parse(content[0].text) as Results;
  assert.equal(result.results.length, 2);
  assert.ok(result.results.every((row) => Number.isFinite(row.score)));
  return result;
}

describe.each(['memory', 'http'] as const)('reranking through MCP (%s)', (transport) => {
  it('serves status while GPU scoring is pending and preserves concurrent reranked results', async () => {
    const { client, cpu, score } = await startRuntime('healthy', transport);
    const plain = await search(client, 'internal links', false);
    assert.deepEqual(
      plain.results.map((r) => r.path),
      ['a.md', 'b.md'],
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const scoring = new Promise<void>((resolve) => {
      started = resolve;
    });
    const calculate = score.getMockImplementation()!;
    score.mockImplementation(async (query, candidates) => {
      started();
      await gate;
      return calculate(query, candidates);
    });
    let finished = false;
    const first = search(client).then((response) => {
      finished = true;
      return response;
    });
    void first.catch(() => undefined);
    let second: Promise<Results> | undefined;
    try {
      await Promise.race([
        scoring,
        first.then(() => {
          throw new Error('GPU scoring was skipped');
        }),
      ]);
      second = search(client, 'links connect notes');
      void second.catch(() => undefined);
      const status = await client.callTool({ name: 'status', arguments: {} }, undefined, {
        timeout: 2000,
      });
      assert.ok(!status.isError);
      assert.equal(finished, false, 'status must respond before the GPU request finishes');
    } finally {
      release();
      await Promise.allSettled(second ? [first, second] : [first]);
    }
    assert.ok(second);
    const replies = await Promise.all([first, second]);
    for (const response of replies) {
      assert.deepEqual(
        response.results.map((r) => r.path),
        ['b.md', 'a.md'],
      );
    }
    assert.equal(cpu.mock.calls.length, 0);
  });

  it.each(['absent', 'load-error', 'score-error', 'invalid'] as const)(
    'keeps MCP usable after %s and reuses CPU after a runtime restart',
    async (mode) => {
      const stderr = vi.spyOn(process.stderr, 'write');
      const first = await startRuntime(mode, transport);
      const response = await search(first.client);
      assert.deepEqual(
        response.results.map((r) => r.path),
        ['b.md', 'a.md'],
      );
      assert.equal(
        first.cpu.mock.calls.flatMap(([inputs]) => inputs).length,
        5,
        'the full request must be rescored on CPU',
      );
      if (mode === 'absent') assert.equal(first.load.mock.calls.length, 0);
      const another = await search(first.client, 'links connect notes');
      assert.deepEqual(
        another.results.map((r) => r.path),
        ['b.md', 'a.md'],
      );
      assert.equal(first.probe.mock.calls.length, 1, 'a long-lived MCP process must not retry GPU');
      await closeRuntime!();
      closeRuntime = undefined;
      const restarted = await startRuntime('healthy', transport);
      assert.deepEqual(await search(restarted.client), response);
      assert.equal(restarted.probe.mock.calls.length, 0);
      assert.equal(restarted.load.mock.calls.length, 0);
      assert.equal(restarted.score.mock.calls.length, 0);
      assert.equal(restarted.cpu.mock.calls.flatMap(([inputs]) => inputs).length, 5);
      const status = await restarted.client.callTool({ name: 'status', arguments: {} });
      assert.ok(!status.isError);
      assert.equal(stderr.mock.calls.length, 0, 'fallback must not print diagnostics');
    },
  );
});
