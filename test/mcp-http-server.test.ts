import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'vitest';
import { runHttpMcpServer, type HttpMcpServerHandle } from '../src/mcp-http-server.js';

let server: HttpMcpServerHandle | undefined;
let vaultDir: string | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;

  if (vaultDir) {
    rmSync(vaultDir, { recursive: true, force: true });
    vaultDir = undefined;
  }

  delete process.env.OBSIDIAN_VAULT_PATH;
});

function createTempVault(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ohs-http-test-'));
  mkdirSync(path.join(dir, '.obsidian'), { recursive: true });
  writeFileSync(path.join(dir, 'alpha.md'), '# Alpha\n\nAlpha note content.\n');
  process.env.OBSIDIAN_VAULT_PATH = dir;
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
  });

  it('initializes MCP and lists tools over Streamable HTTP', async () => {
    vaultDir = createTempVault();
    server = await runHttpMcpServer({ host: '127.0.0.1', port: 0 });

    const initRes = await fetch(server.url, {
      method: 'POST',
      headers: mcpHeaders(),
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
    const sessionId = initRes.headers.get('mcp-session-id');

    assert.equal(initRes.status, 200);
    assert.ok(sessionId, 'initialize should return an MCP session id');

    const toolsRes = await fetch(server.url, {
      method: 'POST',
      headers: { ...mcpHeaders(), 'mcp-session-id': sessionId },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      }),
    });
    const toolsBody = await toolsRes.text();

    assert.equal(toolsRes.status, 200);
    assert.match(toolsBody, /search/);
    assert.match(toolsBody, /read/);
    assert.match(toolsBody, /reindex/);
    assert.match(toolsBody, /status/);
  });
});

function mcpHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
}
