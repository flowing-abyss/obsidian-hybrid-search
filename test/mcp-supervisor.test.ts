import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'vitest';
import {
  buildMcpUrls,
  ensureMcpServer,
  formatPortConflictError,
  getMcpPaths,
  getMcpStatus,
  isPidAlive,
  isPortAvailable,
  readMcpState,
  stopMcpServer,
  writeMcpState,
  type McpState,
} from '../src/mcp-supervisor.js';

let tempDir: string | undefined;
let vaultDir: string | undefined;
let childProcess: ChildProcess | undefined;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalVaultPath = process.env.OBSIDIAN_VAULT_PATH;

afterEach(async () => {
  if (childProcess?.pid && isPidAlive(childProcess.pid)) {
    childProcess.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      childProcess?.once('exit', () => resolve());
      setTimeout(resolve, 500);
    });
  }
  childProcess = undefined;

  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }

  if (vaultDir) {
    rmSync(vaultDir, { recursive: true, force: true });
    vaultDir = undefined;
  }

  if (originalXdgCacheHome === undefined) {
    delete process.env.XDG_CACHE_HOME;
  } else {
    process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  }

  if (originalVaultPath === undefined) {
    delete process.env.OBSIDIAN_VAULT_PATH;
  } else {
    process.env.OBSIDIAN_VAULT_PATH = originalVaultPath;
  }
});

describe('mcp supervisor utilities', () => {
  it('uses XDG_CACHE_HOME for state and log paths', () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'ohs-mcp-supervisor-test-'));
    process.env.XDG_CACHE_HOME = tempDir;

    const paths = getMcpPaths();

    assert.deepEqual(paths, {
      dir: path.join(tempDir, 'obsidian-hybrid-search'),
      statePath: path.join(tempDir, 'obsidian-hybrid-search', 'mcp-state.json'),
      logPath: path.join(tempDir, 'obsidian-hybrid-search', 'mcp.log'),
    });
  });

  it('builds MCP and health URLs from host and port', () => {
    assert.deepEqual(buildMcpUrls('127.0.0.1', 3939), {
      url: 'http://127.0.0.1:3939/mcp',
      healthUrl: 'http://127.0.0.1:3939/health',
    });
  });

  it('round trips state JSON', () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'ohs-mcp-supervisor-test-'));
    process.env.XDG_CACHE_HOME = tempDir;
    const state: McpState = {
      pid: process.pid,
      host: '127.0.0.1',
      port: 3939,
      url: 'http://127.0.0.1:3939/mcp',
      healthUrl: 'http://127.0.0.1:3939/health',
      logPath: path.join(tempDir, 'obsidian-hybrid-search', 'mcp.log'),
      vaultPath: '/tmp/test-vault',
      startedAt: '2026-05-19T00:00:00.000Z',
    };

    writeMcpState(state);

    assert.deepEqual(readMcpState(), state);
  });

  it('checks whether a pid is alive', () => {
    assert.equal(isPidAlive(process.pid), true);
    assert.equal(isPidAlive(999_999_999), false);
    assert.equal(isPidAlive(-1), false);
    assert.equal(isPidAlive(0), false);
  });

  it('reports an occupied port as unavailable', async () => {
    const server = http.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });

    try {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      assert.equal(await isPortAvailable('127.0.0.1', address.port), false);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  });

  it('formats port conflict guidance', () => {
    assert.equal(
      formatPortConflictError(3939),
      `Port 3939 is already in use.

Another MCP server may already be running, or another app is using this port.
Run:

  obsidian-hybrid-search serve status

If this is a different vault/server, choose an explicit port:

  obsidian-hybrid-search serve --port 3940`,
    );
  });

  it('rejects a healthy existing state for a different requested port', async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'ohs-mcp-supervisor-test-'));
    vaultDir = mkdtempSync(path.join(tmpdir(), 'ohs-mcp-supervisor-vault-'));
    process.env.XDG_CACHE_HOME = tempDir;
    process.env.OBSIDIAN_VAULT_PATH = vaultDir;

    const server = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            name: 'obsidian-hybrid-search',
            transport: 'streamable-http',
            vaultPath: vaultDir,
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });

    try {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const existingUrls = buildMcpUrls('127.0.0.1', address.port);
      const state: McpState = {
        pid: process.pid,
        host: '127.0.0.1',
        port: address.port,
        url: existingUrls.url,
        healthUrl: existingUrls.healthUrl,
        logPath: path.join(tempDir, 'obsidian-hybrid-search', 'mcp.log'),
        vaultPath: vaultDir,
        startedAt: '2026-05-19T00:00:00.000Z',
      };
      writeMcpState(state);

      await assert.rejects(
        ensureMcpServer({
          host: '127.0.0.1',
          port: address.port === 65535 ? address.port - 1 : address.port + 1,
        }),
        /already recorded for a different MCP server/,
      );
      assert.deepEqual(readMcpState(), state);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  });

  it('does not stop a live pid when recorded health is unavailable', async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'ohs-mcp-supervisor-test-'));
    vaultDir = mkdtempSync(path.join(tmpdir(), 'ohs-mcp-supervisor-vault-'));
    process.env.XDG_CACHE_HOME = tempDir;
    process.env.OBSIDIAN_VAULT_PATH = vaultDir;

    childProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    assert.ok(childProcess.pid);

    const urls = buildMcpUrls('127.0.0.1', 9);
    writeMcpState({
      pid: childProcess.pid,
      host: '127.0.0.1',
      port: 9,
      url: urls.url,
      healthUrl: urls.healthUrl,
      logPath: path.join(tempDir, 'obsidian-hybrid-search', 'mcp.log'),
      vaultPath: vaultDir,
      startedAt: '2026-05-19T00:00:00.000Z',
    });

    assert.equal(await stopMcpServer(), false);
    assert.equal(readMcpState(), null);
    assert.equal(isPidAlive(childProcess.pid), true);
  });

  it('does not stop a live pid when health identity does not match state', async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'ohs-mcp-supervisor-test-'));
    vaultDir = mkdtempSync(path.join(tmpdir(), 'ohs-mcp-supervisor-vault-'));
    process.env.XDG_CACHE_HOME = tempDir;
    process.env.OBSIDIAN_VAULT_PATH = vaultDir;

    const server = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            name: 'unrelated-service',
            transport: 'streamable-http',
            vaultPath: vaultDir,
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });

    const originalKill = process.kill.bind(process);
    let attemptedSigterm = false;
    process.kill = (pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === process.pid && signal === 'SIGTERM') {
        attemptedSigterm = true;
        return true;
      }
      return originalKill(pid, signal);
    };

    try {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const urls = buildMcpUrls('127.0.0.1', address.port);
      writeMcpState({
        pid: process.pid,
        host: '127.0.0.1',
        port: address.port,
        url: urls.url,
        healthUrl: urls.healthUrl,
        logPath: path.join(tempDir, 'obsidian-hybrid-search', 'mcp.log'),
        vaultPath: vaultDir,
        startedAt: '2026-05-19T00:00:00.000Z',
      });

      assert.equal(await stopMcpServer(), false);
      assert.equal(attemptedSigterm, false);
      assert.equal(readMcpState(), null);
    } finally {
      process.kill = originalKill;
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  });

  it('keeps matching identity state in status checks', async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'ohs-mcp-supervisor-test-'));
    vaultDir = mkdtempSync(path.join(tmpdir(), 'ohs-mcp-supervisor-vault-'));
    process.env.XDG_CACHE_HOME = tempDir;
    process.env.OBSIDIAN_VAULT_PATH = vaultDir;

    const server = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            name: 'obsidian-hybrid-search',
            transport: 'streamable-http',
            vaultPath: vaultDir,
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });

    try {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const urls = buildMcpUrls('127.0.0.1', address.port);
      const state: McpState = {
        pid: process.pid,
        host: '127.0.0.1',
        port: address.port,
        url: urls.url,
        healthUrl: urls.healthUrl,
        logPath: path.join(tempDir, 'obsidian-hybrid-search', 'mcp.log'),
        vaultPath: vaultDir,
        startedAt: '2026-05-19T00:00:00.000Z',
      };
      writeMcpState(state);

      assert.deepEqual(await getMcpStatus(), state);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  });

  it('removes written state when startup health never passes', async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'ohs-mcp-supervisor-test-'));
    vaultDir = mkdtempSync(path.join(tmpdir(), 'ohs-mcp-supervisor-vault-'));
    process.env.XDG_CACHE_HOME = tempDir;
    process.env.OBSIDIAN_VAULT_PATH = vaultDir;

    await assert.rejects(
      ensureMcpServer({ host: '127.0.0.1', port: 0, healthTimeoutMs: 100 }),
      /MCP server did not become healthy/,
    );
    assert.equal(readMcpState(), null);
  });
});
