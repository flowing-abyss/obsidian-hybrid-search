import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import type { HttpMcpServerHandle } from '../src/transports/mcp-http-server.js';

const { closeDb, getDb, initVecTable, openDb, readIndexOwner, upsertNote } =
  await import('./helpers/owned-storage.js');
const { runHttpMcpServer } = await import('../src/transports/mcp-http-server.js');
const searcher = await import('../src/search/searcher.js');

const revision = '2026-07-28';
const metadata = {
  'io.modelcontextprotocol/protocolVersion': revision,
  'io.modelcontextprotocol/clientInfo': { name: 'protocol-regression', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
};
interface RpcReply {
  id: number;
  result?: {
    content?: Array<{ type: string; text?: string }>;
    tools?: Array<{ name: string }>;
    supportedVersions?: string[];
    isError?: boolean;
    [key: string]: unknown;
  };
  error?: { code: number; message: string };
}

let vault: string;
let endpoint: string;
let provider: ReturnType<typeof createServer>;
let httpServer: HttpMcpServerHandle | undefined;
let holdEmbeddings = false;
let embeddingArrived: (() => void) | undefined;
let releaseEmbedding: (() => void) | undefined;
const processes: Array<{
  child: ChildProcessWithoutNullStreams;
  closed: Promise<void>;
}> = [];

beforeEach(async () => {
  holdEmbeddings = false;
  embeddingArrived = undefined;
  releaseEmbedding = undefined;
  vault = mkdtempSync(path.join(tmpdir(), 'ohs-modern-mcp-'));
  mkdirSync(path.join(vault, '.obsidian'));
  provider = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      const input = (JSON.parse(Buffer.concat(chunks).toString() || '{}') as { input?: string[] })
        .input;
      const reply = () =>
        res.end(
          JSON.stringify({
            data: (input ?? []).map((_, index) => ({ index, embedding: [1, 0, 0, 0] })),
          }),
        );
      if (holdEmbeddings) {
        releaseEmbedding = reply;
        embeddingArrived?.();
      } else reply();
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address();
  assert.ok(address && typeof address === 'object');
  endpoint = `http://127.0.0.1:${address.port}/v1`;
  vi.stubEnv('OBSIDIAN_VAULT_PATH', vault);
  vi.stubEnv('OBSIDIAN_PREFIX', '');
  vi.stubEnv('OPENAI_BASE_URL', endpoint);
  vi.stubEnv('OPENAI_EMBEDDING_MODEL', 'protocol-test');
  vi.stubEnv('OPENAI_API_KEY', 'loopback-only');
  const content = 'Alpha contains original knowledge and Unicode текст.\n';
  const filename = path.join(vault, 'alpha.md');
  writeFileSync(filename, content);
  openDb();
  initVecTable(4);
  upsertNote(
    {
      path: 'alpha.md',
      title: 'Alpha',
      tags: [],
      content,
      mtime: statSync(filename).mtimeMs,
      hash: createHash('md5').update(content).digest('hex'),
      chunks: [{ text: content, embedding: new Float32Array([1, 0, 0, 0]) }],
    },
    { modelName: 'protocol-test' },
  );
  closeDb();
});

afterEach(async () => {
  await httpServer?.close();
  httpServer = undefined;
  for (const { child, closed } of processes.splice(0)) {
    child.stdin.end();
    const kill = setTimeout(() => child.kill('SIGKILL'), 5_000);
    try {
      await closed;
    } finally {
      clearTimeout(kill);
    }
  }
  provider.closeAllConnections();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  closeDb();
  rmSync(vault, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function message(id: number, method: string, params: Record<string, unknown> = {}) {
  return { jsonrpc: '2.0', id, method, params: { ...params, _meta: metadata } };
}

async function modernRequest(
  method: string,
  params: Record<string, unknown> = {},
  signal?: AbortSignal,
  headers: Record<string, string> = {},
) {
  assert.ok(httpServer);
  const response = await fetch(httpServer.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': revision,
      'mcp-method': method,
      ...(typeof params.name === 'string' ? { 'mcp-name': params.name } : {}),
      ...headers,
    },
    body: JSON.stringify(message(1, method, params)),
    signal,
  });
  const body = await response.text();
  const json = response.headers.get('content-type')?.includes('text/event-stream')
    ? body
        .split('\n')
        .find((line) => line.startsWith('data: '))
        ?.slice(6)
    : body;
  assert.ok(json, body);
  return { response, reply: JSON.parse(json) as RpcReply };
}

async function requestWithHost(host: string): Promise<number> {
  assert.ok(httpServer);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      httpServer!.url,
      {
        method: 'POST',
        headers: {
          host,
          origin: 'https://client.example.test',
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': revision,
          'mcp-method': 'tools/list',
        },
      },
      (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode ?? 0));
        response.once('error', reject);
      },
    );
    request.once('error', reject);
    request.end(JSON.stringify(message(1, 'tools/list')));
  });
}

describe('modern MCP HTTP', () => {
  it('reports tool failures through the existing isError result contract', async () => {
    httpServer = await runHttpMcpServer({ host: '127.0.0.1', port: 0 });
    const failSearch = vi
      .spyOn(searcher, 'search')
      .mockRejectedValueOnce(new Error('provider unavailable'));
    try {
      const result = await modernRequest('tools/call', {
        name: 'search',
        arguments: { query: 'knowledge' },
      });
      assert.equal(result.response.status, 200);
      assert.equal(result.reply.result?.isError, true);
      assert.match(JSON.stringify(result.reply.result?.content), /provider unavailable/);
    } finally {
      failSearch.mockRestore();
    }
  });

  for (const disconnect of [false, true]) {
    it(`drains active search before closing its database, disconnected=${disconnect}`, async () => {
      httpServer = await runHttpMcpServer({ host: '127.0.0.1', port: 0 });
      const database = getDb();
      holdEmbeddings = true;
      const arrived = new Promise<void>((resolve) => {
        embeddingArrived = resolve;
      });
      const controller = new AbortController();
      const request = modernRequest(
        'tools/call',
        {
          name: 'search',
          arguments: { query: `knowledge ${disconnect}`, mode: 'semantic', rerank: false },
        },
        controller.signal,
      ).catch(() => null);
      await Promise.race([
        arrived,
        request.then((result) => {
          throw new Error(`Search returned before embedding: ${JSON.stringify(result?.reply)}`);
        }),
      ]);
      if (disconnect) controller.abort();
      let closed = false;
      const shutdown = httpServer.close().then(() => {
        closed = true;
      });
      try {
        await delay(50);
        assert.equal(closed, false, 'shutdown must wait for the admitted tool operation');
        assert.equal(database.open, true, 'search still needs its original database handle');
      } finally {
        releaseEmbedding?.();
        await Promise.all([shutdown, request]);
      }
      if (!disconnect) {
        const result = await request;
        assert.ok(result, 'connected client must receive its admitted result');
        assert.equal(result.response.status, 200);
        assert.match(JSON.stringify(result.reply.result?.content), /alpha\.md/);
      }
      assert.equal(database.open, false);
    });
  }

  it('allows concurrent and repeated shutdown', async () => {
    httpServer = await runHttpMcpServer({ host: '127.0.0.1', port: 0 });
    await assert.doesNotReject(Promise.all([httpServer.close(), httpServer.close()]));
    await assert.doesNotReject(httpServer.close());
    httpServer = undefined;
  });

  it('serves discovery and tools without a legacy initialize exchange', async () => {
    httpServer = await runHttpMcpServer({ host: '127.0.0.1', port: 0 });
    const discovery = await modernRequest('server/discover');
    assert.equal(discovery.response.status, 200, JSON.stringify(discovery.reply));
    assert.ok(discovery.reply.result?.supportedVersions?.includes(revision));
    const tools = await modernRequest('tools/list');
    assert.equal(tools.response.status, 200);
    assert.deepEqual(
      tools.reply.result?.tools?.map((tool) => tool.name),
      ['search', 'reindex', 'status', 'read'],
    );
    assert.equal(tools.response.headers.get('mcp-session-id'), null);
  });

  it('preserves search and read payloads while actual v1 and modern clients share the server', async () => {
    httpServer = await runHttpMcpServer({ host: '127.0.0.1', port: 0 });
    const legacy = new Client({ name: 'legacy-regression', version: '1' });
    await legacy.connect(new StreamableHTTPClientTransport(new URL(httpServer.url)));
    try {
      for (const [name, args] of [
        ['search', { query: 'original knowledge', mode: 'fulltext' }],
        ['read', { paths: ['alpha.md'], related: false }],
      ] as const) {
        const old = await legacy.callTool({ name, arguments: args });
        const modern = await modernRequest('tools/call', { name, arguments: args });
        assert.equal(modern.response.status, 200, JSON.stringify(modern.reply));
        assert.deepEqual(modern.reply.result?.content, old.content);
        assert.match(JSON.stringify(modern.reply.result?.content), /alpha\.md/);
      }
    } finally {
      await legacy.close();
    }
  });

  it('preserves prefixes, validation errors and concurrent request isolation', async () => {
    vi.stubEnv('OBSIDIAN_PREFIX', 'work_');
    httpServer = await runHttpMcpServer({ host: '127.0.0.1', port: 0 });
    const listed = await modernRequest('tools/list');
    assert.deepEqual(
      listed.reply.result?.tools?.map((tool) => tool.name),
      ['work_search', 'work_reindex', 'work_status', 'work_read'],
    );
    const reads = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        modernRequest('tools/call', {
          name: index % 2 ? 'read' : 'work_read',
          arguments: { paths: ['alpha.md'], related: false },
        }),
      ),
    );
    for (const read of reads) {
      assert.equal(read.response.status, 200);
      assert.match(JSON.stringify(read.reply.result?.content), /original knowledge/);
    }
    for (const call of [
      { name: 'work_search', arguments: { limit: -1 } },
      { name: 'unknown', arguments: {} },
    ]) {
      const result = await modernRequest('tools/call', call);
      assert.equal(result.reply.result?.isError, true);
    }
    const status = await modernRequest('tools/call', { name: 'work_status' });
    assert.equal(status.response.status, 200);
    assert.equal(status.reply.result?.isError, undefined);
    assert.match(JSON.stringify(status.reply.result?.content), /total/);
  });

  it('keeps Host restrictions and the existing Origin behavior for both eras', async () => {
    httpServer = await runHttpMcpServer({
      host: '127.0.0.1',
      port: 0,
      allowedHosts: ['mcp.example.test'],
    });
    assert.equal(await requestWithHost('evil.example.test'), 403);
    assert.equal(await requestWithHost('mcp.example.test'), 200);
    const legacy = new Client({ name: 'legacy-origin', version: '1' });
    await legacy.connect(
      new StreamableHTTPClientTransport(new URL(httpServer.url), {
        requestInit: { headers: { origin: 'https://client.example.test' } },
      }),
    );
    try {
      assert.equal((await legacy.listTools()).tools.length, 4);
    } finally {
      await legacy.close();
    }
  });

  it('rejects a missing Host header at the MCP boundary', async () => {
    httpServer = await runHttpMcpServer({ host: '127.0.0.1', port: 0 });
    const body = JSON.stringify(message(1, 'tools/list'));
    const port = httpServer.port;
    const response = await new Promise<string>((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port });
      let received = '';
      socket.setTimeout(5_000, () => socket.destroy(new Error('HTTP response timed out')));
      socket.on('error', reject);
      socket.on('data', (chunk: Buffer) => {
        received += chunk.toString();
      });
      socket.on('end', () => resolve(received));
      socket.once('connect', () =>
        socket.end(
          [
            'POST /mcp HTTP/1.0',
            'Content-Type: application/json',
            'Accept: application/json, text/event-stream',
            `Mcp-Protocol-Version: ${revision}`,
            'Mcp-Method: tools/list',
            `Content-Length: ${Buffer.byteLength(body)}`,
            'Connection: close',
            '',
            body,
          ].join('\r\n'),
        ),
      );
    });
    assert.match(response.split('\r\n')[0] ?? '', /^HTTP\/1\.[01] 400 /);
  });

  it('rejects inconsistent protocol envelopes and keeps serving after errors', async () => {
    httpServer = await runHttpMcpServer({ host: '127.0.0.1', port: 0 });
    const mismatchedHeaders: Record<string, string>[] = [
      { 'mcp-method': 'tools/call' },
      { 'mcp-protocol-version': '2999-01-01' },
    ];
    for (const headers of mismatchedHeaders) {
      const result = await modernRequest('tools/list', {}, undefined, headers);
      assert.equal(result.response.status, 400);
      assert.ok(result.reply.error);
    }
    const unknown = await modernRequest('unknown/method');
    assert.equal(unknown.reply.error?.code, -32601);
    const missingMeta = await fetch(httpServer.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': revision,
        'mcp-method': 'tools/list',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    assert.equal(missingMeta.status, 400);
    await missingMeta.text();
    assert.equal((await modernRequest('tools/list')).response.status, 200);
  });
});

function startStdio() {
  const entry = new URL('../src/transports/mcp-stdio-server.ts', import.meta.url).href;
  const script = `
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input, options) => String(input).startsWith('https://registry.npmjs.org/')
      ? Promise.resolve(new Response(JSON.stringify({version:'0.16.4'})))
      : originalFetch(input, options);
    const {runStdioMcpServer} = await import(${JSON.stringify(entry)});
    await runStdioMcpServer();
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, OPENAI_BASE_URL: endpoint, OPENAI_API_KEY: 'loopback-only' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const pending = new Map<number, { resolve(reply: RpcReply): void; reject(error: Error): void }>();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    try {
      const reply = JSON.parse(line) as RpcReply;
      pending.get(reply.id)?.resolve(reply);
      pending.delete(reply.id);
    } catch {
      for (const request of pending.values()) request.reject(new Error(`Non-JSON stdout: ${line}`));
    }
  });
  const closed = new Promise<void>((resolve) =>
    child.once('close', () => {
      for (const request of pending.values()) request.reject(new Error(`Stdio closed: ${stderr}`));
      pending.clear();
      lines.close();
      resolve();
    }),
  );
  processes.push({ child, closed });
  let id = 0;
  return {
    child,
    closed,
    stderr: () => stderr,
    async request(method: string, params: Record<string, unknown> = {}): Promise<RpcReply> {
      const requestId = ++id;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        return await new Promise<RpcReply>((resolve, reject) => {
          pending.set(requestId, { resolve, reject });
          timeout = setTimeout(
            () => reject(new Error(`Stdio request timed out: ${stderr}`)),
            5_000,
          );
          child.stdin.write(JSON.stringify(message(requestId, method, params)) + '\n');
        });
      } finally {
        clearTimeout(timeout);
        pending.delete(requestId);
      }
    },
  };
}

describe('modern MCP stdio', () => {
  it('exits after fatal transport closure and releases indexing ownership', async () => {
    const session = startStdio();
    assert.ok((await session.request('server/discover')).result);
    openDb();
    await vi.waitFor(() => assert.equal(readIndexOwner().mode, 'background'), { timeout: 5_000 });
    session.child.stdin.once('error', () => {}); // A fatal peer close may interrupt this oversized write.
    session.child.stdin.write(Buffer.alloc(11 * 1024 * 1024, 'x'));
    const exited = await Promise.race([
      session.closed.then(() => true),
      delay(3_000).then(() => false),
    ]);
    assert.equal(exited, true, 'fatal wire closure must stop the MCP process');
    assert.equal(session.child.exitCode, 1);
    assert.match(session.stderr(), /ReadBuffer exceeded maximum size/);
    assert.equal(readIndexOwner().token, null, 'shutdown must release the database lease');
  });

  it('reports invalid envelopes on stderr without echoing their contents and keeps serving', async () => {
    const session = startStdio();
    session.child.stdin.write(
      JSON.stringify({ jsonrpc: 'VAULT_SECRET_SENTINEL', id: 0, method: 'tools/list' }) + '\n',
    );
    const discovery = await session.request('server/discover');
    assert.ok(discovery.result?.supportedVersions?.includes(revision));
    session.child.stdin.end();
    await session.closed;
    assert.match(session.stderr(), /protocol error/);
    assert.doesNotMatch(session.stderr(), /VAULT_/);
  });

  it('discovers and reads over actual stdio, then exits cleanly on EOF', async () => {
    const session = startStdio();
    const discovery = await session.request('server/discover');
    assert.ok(discovery.result?.supportedVersions?.includes(revision), JSON.stringify(discovery));
    const tools = await session.request('tools/list');
    assert.ok(tools.result?.tools?.some((tool) => tool.name === 'read'));
    const read = await session.request('tools/call', {
      name: 'read',
      arguments: { paths: ['alpha.md'] },
    });
    assert.match(JSON.stringify(read.result?.content), /original knowledge/);
    session.child.stdin.end();
    await session.closed;
    assert.equal(session.child.exitCode, 0);
  });
});
