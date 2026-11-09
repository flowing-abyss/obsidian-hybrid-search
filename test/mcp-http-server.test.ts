import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import type { HttpMcpServerHandle } from '../src/transports/mcp-http-server.js';

const { closeDb, initVecTable, openDb, upsertMarkdownLinks, upsertNote } =
  await import('./helpers/owned-storage.js');
const { runHttpMcpServer } = await import('../src/transports/mcp-http-server.js');

let server: HttpMcpServerHandle | undefined;
let vaultDir: string | undefined;
const authToken = 'test-only-token-0123456789abcdef0123456789abcdef';

beforeEach(() => {
  vi.stubEnv('OBSIDIAN_MCP_AUTH_TOKEN', undefined);
});

afterEach(async () => {
  await server?.close();
  server = undefined;

  if (vaultDir) {
    rmSync(vaultDir, { recursive: true, force: true });
    vaultDir = undefined;
  }

  delete process.env.OBSIDIAN_VAULT_PATH;
  vi.unstubAllEnvs();
});

function createTempVault(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ohs-http-test-'));
  mkdirSync(path.join(dir, '.obsidian'), { recursive: true });
  writeFileSync(path.join(dir, 'alpha.md'), '# Alpha\n\nAlpha note content.\n');
  process.env.OBSIDIAN_VAULT_PATH = dir;
  openDb();
  initVecTable(4);
  closeDb();
  return dir;
}

describe('runHttpMcpServer', () => {
  it('serves health metadata over HTTP', async () => {
    vaultDir = createTempVault();
    server = await runHttpMcpServer({ host: '127.0.0.1', port: 0 });

    const res = await fetch(server.healthUrl);
    const body = (await res.json()) as {
      ok: boolean;
      transport: string;
      vaultPath: string;
    };

    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.transport, 'streamable-http');
    assert.equal(body.vaultPath, vaultDir);
  }, 30_000);

  it('serves tools without issuing an MCP session id', async () => {
    vaultDir = createTempVault();
    server = await runHttpMcpServer({ host: '127.0.0.1', port: 0 });

    await initializeMcpSession(server.url);

    const toolsRes = await fetch(server.url, {
      method: 'POST',
      headers: mcpHeaders(),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      }),
    });
    const toolsBody = await toolsRes.text();

    assert.equal(toolsRes.status, 200);
    assert.equal(toolsRes.headers.get('mcp-session-id'), null);
    assert.match(toolsBody, /search/);
    assert.match(toolsBody, /read/);
    assert.match(toolsBody, /reindex/);
    assert.match(toolsBody, /status/);
  }, 30_000);

  it('allows MCP initialize requests for extra allowed Host headers', async () => {
    vaultDir = createTempVault();
    server = await runHttpMcpServer({
      host: '127.0.0.1',
      port: 0,
      allowedHosts: ['example.tailnet.ts.net:3939'],
    });

    const { status, sessionId } = await initializeMcpSessionWithHost(
      server.url,
      'example.tailnet.ts.net:3939',
    );

    assert.equal(status, 200);
    assert.equal(sessionId, null);
  });

  it('expands host-only allowed Host entries to the bound port', async () => {
    vaultDir = createTempVault();
    server = await runHttpMcpServer({
      host: '127.0.0.1',
      port: 0,
      allowedHosts: ['example.tailnet.ts.net'],
    });

    const { status, sessionId } = await initializeMcpSessionWithHost(
      server.url,
      `example.tailnet.ts.net:${server.port}`,
    );

    assert.equal(status, 200);
    assert.equal(sessionId, null);
  });

  it('rejects MCP initialize requests for unlisted Host headers', async () => {
    vaultDir = createTempVault();
    server = await runHttpMcpServer({ host: '127.0.0.1', port: 0 });

    const initRes = await initializeMcpSessionWithHost(server.url, 'example.tailnet.ts.net:3939');

    assert.equal(initRes.status, 403);
  });

  it('rejects health requests for unlisted Host headers', async () => {
    vaultDir = createTempVault();
    server = await runHttpMcpServer({ host: '127.0.0.1', port: 0 });

    const status = await requestHealthWithHost(server.healthUrl, 'example.tailnet.ts.net:3939');

    assert.equal(status, 403);
  });

  it('allows any Host header when explicitly configured', async () => {
    vaultDir = createTempVault();
    vi.stubEnv('OBSIDIAN_MCP_AUTH_TOKEN', authToken);
    server = await runHttpMcpServer({ host: '127.0.0.1', port: 0, allowAnyHost: true });

    const { status, sessionId } = await initializeMcpSessionWithHost(
      server.url,
      'example.tailnet.ts.net:3939',
      { authorization: `Bearer ${authToken}` },
    );

    assert.equal(status, 200);
    assert.equal(sessionId, null);
  });

  it('requires a token before exposing the server beyond loopback', async () => {
    await assert.rejects(runHttpMcpServer({ host: '0.0.0.0', port: 0 }), /OBSIDIAN_MCP_AUTH_TOKEN/);
    await assert.rejects(
      runHttpMcpServer({ host: '127.0.0.1', port: 0, allowAnyHost: true }),
      /OBSIDIAN_MCP_AUTH_TOKEN/,
    );
  });

  it('authenticates both health and MCP without revealing vault metadata', async () => {
    vaultDir = createTempVault();
    vi.stubEnv('OBSIDIAN_MCP_AUTH_TOKEN', authToken);
    server = await runHttpMcpServer({ host: '127.0.0.1', port: 0 });

    for (const authorization of [undefined, 'Bearer wrong-token', `Basic ${authToken}`]) {
      const headers = authorization ? { authorization } : undefined;
      const res: Response = await fetch(server.healthUrl, { headers });
      assert.equal(res.status, 401);
      assert.match(res.headers.get('www-authenticate') ?? '', /^Bearer /);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal((await res.text()).includes(vaultDir), false);
    }

    const mcpRes = await fetch(server.url, { method: 'POST', headers: mcpHeaders(), body: '{}' });
    assert.equal(mcpRes.status, 401);
    await mcpRes.text();
    const headers = { authorization: `Bearer ${authToken}` };
    const health = await fetch(server.healthUrl, { headers });
    assert.equal(health.status, 200);
    assert.equal(((await health.json()) as { vaultPath: string }).vaultPath, vaultDir);
    await initializeMcpSession(server.url, headers);
  });

  it('rejects invalid and cross-origin browser requests even with a valid Host', async () => {
    vaultDir = createTempVault();
    server = await runHttpMcpServer({
      host: '127.0.0.1',
      port: 0,
      allowedHosts: ['other.example:3939'],
    });
    const sameOrigin = new URL(server.url).origin;
    for (const origin of [
      'https://untrusted.example',
      'http://other.example:3939',
      'http://127.0.0.1:1',
      'null',
      'not a URL',
      `${sameOrigin}/path`,
      `${sameOrigin}/`,
    ]) {
      const res: Response = await fetch(server.healthUrl, { headers: { origin } });
      assert.equal(res.status, 403, origin);
      assert.match(await res.text(), /Origin/);
    }
    await initializeMcpSession(server.url, { origin: sameOrigin });
  });

  it('checks Origin even when bearer authentication and allow-any-host are enabled', async () => {
    vaultDir = createTempVault();
    vi.stubEnv('OBSIDIAN_MCP_AUTH_TOKEN', authToken);
    server = await runHttpMcpServer({ host: '127.0.0.1', port: 0, allowAnyHost: true });
    const res = await fetch(server.url, {
      method: 'POST',
      headers: {
        ...mcpHeaders(),
        authorization: `Bearer ${authToken}`,
        origin: 'https://untrusted.example',
      },
      body: '{}',
    });
    assert.equal(res.status, 403);
    await res.text();
  });

  it('retains the SDK body-size guard before dispatching tool calls', async () => {
    vaultDir = createTempVault();
    server = await runHttpMcpServer({ host: '127.0.0.1', port: 0 });
    const res = await fetch(server.url, {
      method: 'POST',
      headers: mcpHeaders(),
      body: 'x'.repeat(4 * 1024 * 1024 + 1),
    });
    assert.equal(res.status, 413);
    await res.text();
    await initializeMcpSession(server.url);
  });

  it('bounds concurrent request bodies and releases capacity after uploads finish', async () => {
    vaultDir = createTempVault();
    server = await runHttpMcpServer({ host: '127.0.0.1', port: 0 });
    const uploads = Array.from({ length: 32 }, () => pendingUpload(server!.url));
    try {
      await Promise.all(uploads.map((upload) => upload.admitted));
      const overflow = await fetch(server.url, {
        method: 'POST',
        headers: mcpHeaders(),
        body: '{}',
      });
      assert.equal(overflow.status, 429);
      assert.equal(overflow.headers.get('retry-after'), '1');
      await overflow.text();
    } finally {
      for (const upload of uploads) upload.request.end('{}');
      await Promise.all(uploads.map((upload) => upload.finished));
    }
    await initializeMcpSession(server.url);
  });

  it('answers non-POST requests on /mcp with 405 and an Allow header', async () => {
    vaultDir = createTempVault();
    server = await runHttpMcpServer({ host: '127.0.0.1', port: 0 });
    const url = server.url;

    for (const method of ['GET', 'DELETE'] as const) {
      const res = await fetch(url, { method, headers: mcpHeaders() });

      assert.equal(res.status, 405, `${method} /mcp should not be allowed`);
      assert.equal(res.headers.get('allow'), 'POST');
      await res.text();
    }
  });

  it('accepts a stale session header after the HTTP server restarts', async () => {
    vaultDir = createTempVault();
    server = await runHttpMcpServer({ host: '127.0.0.1', port: 0 });
    await initializeMcpSession(server.url);
    const url = server.url;

    await server.close();
    server = await runHttpMcpServer({ host: '127.0.0.1', port: Number(new URL(url).port) });

    const toolsRes = await fetch(server.url, {
      method: 'POST',
      headers: { ...mcpHeaders(), 'mcp-session-id': 'session-from-before-restart' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      }),
    });

    assert.equal(toolsRes.status, 200);
    assert.equal(toolsRes.headers.get('mcp-session-id'), null);
    assert.match(await toolsRes.text(), /search/);

    const toolRes = await fetch(server.url, {
      method: 'POST',
      headers: { ...mcpHeaders(), 'mcp-session-id': 'session-from-before-restart' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'status', arguments: {} },
      }),
    });

    assert.equal(toolRes.status, 200);
    assert.equal(toolRes.headers.get('mcp-session-id'), null);
    assert.match(await toolRes.text(), /\\"indexed\\"/);
  }, 30_000);

  it('returns a readable MCP error for invalid search arguments', async () => {
    vaultDir = createTempVault();
    server = await runHttpMcpServer({ host: '127.0.0.1', port: 0 });
    await initializeMcpSession(server.url);

    const body = await callTool(server.url, 'search', { query: 'alpha', threshold: 2 });
    const result = parseToolCallResult(body);

    assert.equal(result.isError, true);
    assert.match(body, /Invalid search arguments/);
    assert.match(body, /threshold/);
  });

  it('returns a readable MCP error for invalid read arguments', async () => {
    vaultDir = createTempVault();
    server = await runHttpMcpServer({ host: '127.0.0.1', port: 0 });
    await initializeMcpSession(server.url);

    const body = await callTool(server.url, 'read', { paths: 123 });
    const result = parseToolCallResult(body);

    assert.equal(result.isError, true);
    assert.match(body, /Invalid read arguments/);
    assert.match(body, /paths/);
  });

  it('passes link_type through to related Markdown graph traversal', async () => {
    vaultDir = createTempVault();
    writeFileSync(path.join(vaultDir, 'beta.md'), '# Beta\n\nBeta note content.\n');
    const fakeEmbedding = new Float32Array([0.5, 0.5, 0.5, 0.5]);
    openDb();
    upsertNote({
      path: 'alpha.md',
      title: 'Alpha',
      tags: [],
      content: 'Alpha links to [Beta](beta.md).',
      mtime: Date.now(),
      hash: 'alpha-hash',
      chunks: [{ text: 'Alpha links to Beta.', embedding: fakeEmbedding }],
    });
    upsertNote({
      path: 'beta.md',
      title: 'Beta',
      tags: [],
      content: 'Beta note content.',
      mtime: Date.now(),
      hash: 'beta-hash',
      chunks: [{ text: 'Beta note content.', embedding: fakeEmbedding }],
    });
    upsertMarkdownLinks('alpha.md', ['beta.md']);
    closeDb();
    server = await runHttpMcpServer({ host: '127.0.0.1', port: 0 });
    await initializeMcpSession(server.url);

    const body = await callTool(server.url, 'search', {
      path: 'alpha.md',
      related: true,
      direction: 'outgoing',
      depth: 1,
      link_type: 'markdown',
    });
    const results = parseSearchToolResults(body);

    assert.deepEqual(
      results.map((result) => result.path),
      ['alpha.md', 'beta.md'],
    );
    assert.ok(results[1]?.matchedBy.includes('markdown_link'));
  });
});

function mcpHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
}

function pendingUpload(url: string) {
  const request = http.request(url, {
    method: 'POST',
    headers: { ...mcpHeaders(), expect: '100-continue', 'content-length': '2' },
  });
  const admitted = new Promise<void>((resolve, reject) => {
    request.once('continue', resolve);
    request.once('error', reject);
  });
  const finished = new Promise<void>((resolve, reject) => {
    request.once('response', (response) => {
      response.resume();
      response.once('end', resolve);
    });
    request.once('error', reject);
  });
  request.flushHeaders();
  return { request, admitted, finished };
}

async function initializeMcpSession(
  url: string,
  extraHeaders: Record<string, string> = {},
): Promise<void> {
  const initRes = await fetch(url, {
    method: 'POST',
    headers: { ...mcpHeaders(), ...extraHeaders },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'vitest', version: '1.0.0' },
      },
    }),
  });
  assert.equal(initRes.status, 200);
  assert.equal(initRes.headers.get('mcp-session-id'), null);
}

function initializeMcpSessionWithHost(
  url: string,
  hostHeader: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; sessionId: string | null }> {
  const parsed = new URL(url);
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'vitest', version: '1.0.0' },
    },
  });

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'POST',
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        headers: {
          ...mcpHeaders(),
          host: hostHeader,
          'content-length': Buffer.byteLength(body),
          ...extraHeaders,
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            sessionId: res.headers['mcp-session-id']?.toString() ?? null,
          });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function requestHealthWithHost(url: string, hostHeader: string): Promise<number> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'GET',
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        headers: { host: hostHeader },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function callTool(url: string, name: string, args: Record<string, unknown>): Promise<string> {
  const res = await fetch(url, {
    method: 'POST',
    headers: mcpHeaders(),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name,
        arguments: args,
      },
    }),
  });

  assert.equal(res.status, 200);
  return res.text();
}

function parseToolCallResult(body: string): { isError?: boolean } {
  const dataLine = body.split('\n').find((line) => line.startsWith('data: '));
  assert.ok(dataLine, 'Streamable HTTP response should include a data event');

  const message = JSON.parse(dataLine.slice('data: '.length)) as {
    result?: { isError?: boolean };
  };
  assert.ok(message.result, 'tools/call response should include a result');

  return message.result;
}

function parseSearchToolResults(body: string): Array<{ path: string; matchedBy: string[] }> {
  const dataLine = body.split('\n').find((line) => line.startsWith('data: '));
  assert.ok(dataLine, 'Streamable HTTP response should include a data event');

  const message = JSON.parse(dataLine.slice('data: '.length)) as {
    result?: { content?: Array<{ text?: string }> };
  };
  const text = message.result?.content?.[0]?.text;
  assert.ok(text, 'tools/call response should include text content');
  const parsed = JSON.parse(text) as { results: Array<{ path: string; matchedBy: string[] }> };
  return parsed.results;
}
