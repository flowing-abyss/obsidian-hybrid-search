import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, it, vi } from 'vitest';

// ─── Vault setup (must precede application module imports) ────────────────────

const vaultDir = mkdtempSync(path.join(tmpdir(), 'ohs-mcp-runtime-tools-'));
process.env.OBSIDIAN_VAULT_PATH = vaultDir;

// Per the Wave 3 lesson: do NOT use vi.mock('../src/embedder.js', factory) — it
// conflicts with other test files under vitest's isolate:false. Spy on the real
// imported module instead.
const embedder = await import('../src/embedder.js');
vi.spyOn(embedder, 'embed').mockResolvedValue([new Float32Array([0.1, 0.2, 0.3, 0.4])]);
vi.spyOn(embedder, 'getContextLength').mockResolvedValue(512);

const { closeDb, openDb, initVecTable, upsertNote } = await import('../src/db.js');
const { createMcpRuntime, createMcpServer, checkForUpdates, packageVersion } =
  await import('../src/mcp-runtime.js');

const fakeEmbedding = new Float32Array([0.1, 0.2, 0.3, 0.4]);

beforeAll(() => {
  // Write a note file so scanVault has something to find during indexing paths.
  writeFileSync(path.join(vaultDir, 'tool-test.md'), 'Content for tool testing.');
  openDb();
  initVecTable(4);
  upsertNote({
    path: 'tool-test.md',
    title: 'Tool Test Note',
    tags: ['test'],
    content: 'Content for tool testing.',
    mtime: Date.now(),
    hash: 'h-tool',
    chunks: [{ text: 'Content for tool testing', embedding: fakeEmbedding }],
  });
});

afterAll(() => {
  vi.mocked(embedder.embed).mockRestore();
  vi.mocked(embedder.getContextLength).mockRestore();
  vi.unstubAllGlobals();
  closeDb();
  rmSync(vaultDir, { recursive: true, force: true });
});

// ─── checkForUpdates — edge cases ────────────────────────────────────────────

describe('checkForUpdates — edge cases', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sets up_to_date when registry version matches (never throws)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ version: packageVersion }),
      }),
    );
    // checkForUpdates catches all errors internally; the contract is "no throw".
    await checkForUpdates(packageVersion);
    const runtime = await createMcpRuntime();
    assert.equal(runtime.getUpdateStatus().state, 'up_to_date');
  });

  it('sets update_available when registry version differs (never throws)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ version: '99.99.99' }),
      }),
    );
    await checkForUpdates(packageVersion);
    const runtime = await createMcpRuntime();
    assert.equal(runtime.getUpdateStatus().state, 'update_available');
  });

  it('sets offline on network failure (never throws)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    await checkForUpdates(packageVersion);
    const runtime = await createMcpRuntime();
    assert.equal(runtime.getUpdateStatus().state, 'offline');
  });

  it('sets offline on non-ok HTTP (never throws)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    await checkForUpdates(packageVersion);
    const runtime = await createMcpRuntime();
    assert.equal(runtime.getUpdateStatus().state, 'offline');
  });

  it('sets offline when json() throws (never throws)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.reject(new Error('invalid json')),
      }),
    );
    await checkForUpdates(packageVersion);
    const runtime = await createMcpRuntime();
    assert.equal(runtime.getUpdateStatus().state, 'offline');
  });

  it('uses default version when called with no argument (never throws)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ version: packageVersion }),
      }),
    );
    await checkForUpdates();
    const runtime = await createMcpRuntime();
    assert.equal(runtime.getUpdateStatus().state, 'up_to_date');
  });
});

// ─── createMcpServer — tool dispatch ─────────────────────────────────────────

describe('createMcpServer — tool dispatch', () => {
  it('creates a server instance', async () => {
    const runtime = await createMcpRuntime();
    const server = createMcpServer(runtime);
    assert.ok(server);
  });

  // The MCP SDK stores handlers in a private Map keyed by method name. Access
  // it directly to invoke the handler without a full transport round-trip. The
  // SDK wraps each handler so it first parses the incoming request against the
  // request schema (which requires `method` to match the literal, e.g.
  // 'tools/list' / 'tools/call'). Construct minimal valid requests accordingly.
  function getHandler(
    server: Server,
    method: string,
  ): (req: unknown, extra: unknown) => Promise<unknown> {
    // The MCP SDK keeps registered handlers in a private Map. Reach in via a
    // minimal structural cast — the SDK exposes no public accessor for this.
    const handlers = (server as unknown as { _requestHandlers: Map<string, unknown> })
      ._requestHandlers;
    const handler = handlers.get(method);
    assert.ok(typeof handler === 'function', `${method} handler registered`);
    return handler as (req: unknown, extra: unknown) => Promise<unknown>;
  }

  it('registers a tools/list handler that returns 4 tools', async () => {
    const runtime = await createMcpRuntime();
    const server = createMcpServer(runtime);
    const listHandler = getHandler(server, 'tools/list');
    const result = (await listHandler({ method: 'tools/list' }, {})) as {
      tools: { name: string; description: string; inputSchema: unknown }[];
    };
    assert.ok(Array.isArray(result.tools));
    assert.equal(result.tools.length, 4);
    const names = result.tools.map((t) => t.name).sort((a, b) => a.localeCompare(b));
    assert.deepEqual(names, ['read', 'reindex', 'search', 'status']);
    for (const tool of result.tools) {
      assert.ok(typeof tool.description === 'string' && tool.description.length > 0);
      assert.ok(tool.inputSchema && typeof tool.inputSchema === 'object');
    }
  });

  it('registers a tools/call handler that dispatches to read', async () => {
    const runtime = await createMcpRuntime();
    const server = createMcpServer(runtime);
    const callHandler = getHandler(server, 'tools/call');
    const result = (await callHandler(
      { method: 'tools/call', params: { name: 'read', arguments: { paths: 'tool-test.md' } } },
      {},
    )) as { content: { type: string; text: string }[]; isError?: true };
    assert.ok(Array.isArray(result.content));
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0]?.type, 'text');
    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as {
      results: { path: string; found: boolean }[];
    };
    assert.ok(Array.isArray(parsed.results));
    assert.equal(parsed.results[0]?.path, 'tool-test.md');
    assert.equal(parsed.results[0]?.found, true);
  });

  it('tools/call returns validation error for unknown tool', async () => {
    const runtime = await createMcpRuntime();
    const server = createMcpServer(runtime);
    const callHandler = getHandler(server, 'tools/call');
    const result = (await callHandler(
      { method: 'tools/call', params: { name: 'nonexistent', arguments: {} } },
      {},
    )) as { content: { type: string; text: string }[]; isError?: true };
    assert.equal(result.isError, true);
    assert.ok(result.content[0]?.text.includes('Unknown tool'));
  });

  it('tools/call search returns results array for a known note', async () => {
    const runtime = await createMcpRuntime();
    const server = createMcpServer(runtime);
    const callHandler = getHandler(server, 'tools/call');
    const result = (await callHandler(
      { method: 'tools/call', params: { name: 'search', arguments: { query: 'tool testing' } } },
      {},
    )) as { content: { type: string; text: string }[]; isError?: true };
    assert.ok(!result.isError, `unexpected error: ${result.content[0]?.text}`);
    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as { results: unknown[] };
    assert.ok(Array.isArray(parsed.results));
  });

  it('tools/call status returns a JSON object with expected fields', async () => {
    const runtime = await createMcpRuntime();
    const server = createMcpServer(runtime);
    const callHandler = getHandler(server, 'tools/call');
    const result = (await callHandler(
      { method: 'tools/call', params: { name: 'status', arguments: {} } },
      {},
    )) as { content: { type: string; text: string }[]; isError?: true };
    assert.ok(!result.isError);
    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
    assert.ok(typeof parsed.total === 'number');
    assert.ok(typeof parsed.version === 'string');
    assert.ok(typeof parsed.context_length === 'number');
  });

  it('tools/call read with array of paths returns one result per path', async () => {
    const runtime = await createMcpRuntime();
    const server = createMcpServer(runtime);
    const callHandler = getHandler(server, 'tools/call');
    const result = (await callHandler(
      {
        method: 'tools/call',
        params: { name: 'read', arguments: { paths: ['tool-test.md', 'missing.md'] } },
      },
      {},
    )) as { content: { type: string; text: string }[]; isError?: true };
    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as {
      results: { path: string; found: boolean }[];
    };
    assert.equal(parsed.results.length, 2);
    assert.equal(parsed.results[0]?.found, true);
    assert.equal(parsed.results[1]?.found, false);
  });

  it('respects OBSIDIAN_PREFIX on tool names', async () => {
    const prevPrefix = process.env.OBSIDIAN_PREFIX;
    process.env.OBSIDIAN_PREFIX = 'work_';
    try {
      const runtime = await createMcpRuntime();
      const server = createMcpServer(runtime);
      const listHandler = getHandler(server, 'tools/list');
      const result = (await listHandler({ method: 'tools/list' }, {})) as {
        tools: { name: string }[];
      };
      const names = result.tools.map((t) => t.name).sort((a, b) => a.localeCompare(b));
      assert.deepEqual(names, ['work_read', 'work_reindex', 'work_search', 'work_status']);
    } finally {
      process.env.OBSIDIAN_PREFIX = prevPrefix;
    }
  });
});
