import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'vitest';
import {
  buildMcpServeArgs,
  buildMcpUrls,
  formatMcpInfo,
  formatPortConflictError,
  getMcpPaths,
  healthMatchesState,
  isPidAlive,
  isPortAvailable,
  matchesRequestedState,
  readMcpState,
  removeMcpState,
  writeMcpState,
  type EnsureMcpOptions,
  type McpState,
} from '../src/mcp-supervisor.js';

const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
  if (originalXdgCacheHome === undefined) {
    delete process.env.XDG_CACHE_HOME;
  } else {
    process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  }
});

describe('isPidAlive — edge cases', () => {
  it('returns true for current process PID', () => {
    assert.equal(isPidAlive(process.pid), true);
  });

  it('returns false for non-integer', () => {
    assert.equal(isPidAlive(1.5), false);
  });

  it('returns false for zero', () => {
    assert.equal(isPidAlive(0), false);
  });

  it('returns false for negative', () => {
    assert.equal(isPidAlive(-1), false);
  });

  it('returns false for non-existent PID', () => {
    assert.equal(isPidAlive(999999), false);
  });
});

describe('isPortAvailable — edge cases', () => {
  it('returns true for free ephemeral port', async () => {
    // Bind a server to port 0 to claim an ephemeral port, release it, then
    // immediately re-check the same port. Avoids Math.random (sonarjs).
    const server = http.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const addr = server.address();
    assert.ok(addr && typeof addr === 'object');
    const port = addr.port;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    const result = await isPortAvailable('127.0.0.1', port);
    assert.equal(result, true);
  });

  it('returns false for port already in use', async () => {
    const server = http.createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    assert.ok(addr && typeof addr === 'object');
    const port = addr.port;
    const result = await isPortAvailable('127.0.0.1', port);
    assert.equal(result, false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

describe('MCP state persistence — edge cases', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'ohs-mcp-state-'));
    process.env.XDG_CACHE_HOME = tempDir;
  });

  it('readMcpState returns null when no state file', () => {
    assert.equal(readMcpState(), null);
  });

  it('writeMcpState then readMcpState round-trips', () => {
    const state: McpState = {
      pid: 12345,
      host: '127.0.0.1',
      port: 3939,
      url: 'http://127.0.0.1:3939/mcp',
      healthUrl: 'http://127.0.0.1:3939/health',
      logPath: '/tmp/log',
      vaultPath: '/vault',
      startedAt: '2026-01-01T00:00:00Z',
    };
    writeMcpState(state);
    const read = readMcpState();
    assert.deepEqual(read, state);
  });

  it('readMcpState returns null for corrupt JSON', () => {
    const { dir, statePath } = getMcpPaths();
    mkdirSync(dir, { recursive: true });
    writeFileSync(statePath, 'not json{');
    assert.equal(readMcpState(), null);
  });

  it('removeMcpState on existing file removes it', () => {
    const state: McpState = {
      pid: 12345,
      host: '127.0.0.1',
      port: 3939,
      url: 'http://127.0.0.1:3939/mcp',
      healthUrl: 'http://127.0.0.1:3939/health',
      logPath: '/tmp/log',
      vaultPath: '/vault',
      startedAt: '2026-01-01T00:00:00Z',
    };
    writeMcpState(state);
    removeMcpState();
    assert.equal(readMcpState(), null);
  });

  it('removeMcpState on missing file does not error', () => {
    removeMcpState();
    assert.equal(readMcpState(), null);
  });
});

describe('matchesRequestedState — edge cases', () => {
  const baseState: McpState = {
    pid: 12345,
    host: '127.0.0.1',
    port: 3939,
    url: 'http://127.0.0.1:3939/mcp',
    healthUrl: 'http://127.0.0.1:3939/health',
    logPath: '/tmp/log',
    vaultPath: '/vault',
    startedAt: '2026-01-01T00:00:00Z',
  };
  const baseOptions: EnsureMcpOptions = {
    host: '127.0.0.1',
    port: 3939,
  };

  it('returns true for matching state', () => {
    assert.equal(matchesRequestedState(baseState, baseOptions, '/vault'), true);
  });

  it('returns false for different host', () => {
    assert.equal(
      matchesRequestedState(baseState, { ...baseOptions, host: '0.0.0.0' }, '/vault'),
      false,
    );
  });

  it('returns false for different port', () => {
    assert.equal(matchesRequestedState(baseState, { ...baseOptions, port: 4000 }, '/vault'), false);
  });

  it('returns false for different vaultPath', () => {
    assert.equal(matchesRequestedState(baseState, baseOptions, '/different'), false);
  });

  it('allowAnyHost mismatch returns false', () => {
    const stateWithAny = { ...baseState, allowAnyHost: true };
    assert.equal(matchesRequestedState(stateWithAny, baseOptions, '/vault'), false);
  });

  it('both allowAnyHost true ignores hosts', () => {
    const stateWithAny = { ...baseState, allowAnyHost: true };
    const optsWithAny = { ...baseOptions, allowAnyHost: true };
    assert.equal(matchesRequestedState(stateWithAny, optsWithAny, '/vault'), true);
  });

  it('allowedHosts with same elements different order returns true', () => {
    const stateWithHosts = { ...baseState, allowedHosts: ['host1', 'host2'] };
    const optsWithHosts = { ...baseOptions, allowedHosts: ['host2', 'host1'] };
    assert.equal(matchesRequestedState(stateWithHosts, optsWithHosts, '/vault'), true);
  });

  it('allowedHosts with different elements returns false', () => {
    const stateWithHosts = { ...baseState, allowedHosts: ['host1', 'host2'] };
    const optsWithHosts = { ...baseOptions, allowedHosts: ['host1', 'host3'] };
    assert.equal(matchesRequestedState(stateWithHosts, optsWithHosts, '/vault'), false);
  });
});

describe('formatPortConflictError — edge cases', () => {
  it('contains the port number', () => {
    const msg = formatPortConflictError(3939);
    assert.match(msg, /3939/);
  });

  it('contains serve status suggestion', () => {
    const msg = formatPortConflictError(3939);
    assert.match(msg, /serve status/);
  });

  it('suggests alternative port (port+1)', () => {
    const msg = formatPortConflictError(3939);
    assert.match(msg, /3940/);
  });
});

describe('formatMcpInfo — edge cases', () => {
  const state: McpState = {
    pid: 12345,
    host: '127.0.0.1',
    port: 3939,
    url: 'http://127.0.0.1:3939/mcp',
    healthUrl: 'http://127.0.0.1:3939/health',
    logPath: '/tmp/mcp.log',
    vaultPath: '/vault',
    startedAt: '2026-01-01T00:00:00Z',
  };

  it('started=true says "is running"', () => {
    const info = formatMcpInfo(state, true);
    assert.match(info, /is running/);
  });

  it('started=false says "is already running"', () => {
    const info = formatMcpInfo(state, false);
    assert.match(info, /is already running/);
  });

  it('contains URL, PID, and log path', () => {
    const info = formatMcpInfo(state, true);
    assert.match(info, /http:\/\/127\.0\.0\.1:3939\/mcp/);
    assert.match(info, /12345/);
    assert.match(info, /\/tmp\/mcp\.log/);
  });

  it('contains JSON snippet for MCP client config', () => {
    const info = formatMcpInfo(state, true);
    assert.match(info, /mcpServers/);
  });
});

describe('buildMcpServeArgs — edge cases', () => {
  it('includes host and port', () => {
    const args = buildMcpServeArgs({ host: '127.0.0.1', port: 3939 });
    assert.ok(args.includes('--host'));
    assert.ok(args.includes('127.0.0.1'));
    assert.ok(args.includes('--port'));
    assert.ok(args.includes('3939'));
  });

  it('includes allowed hosts when provided', () => {
    // Implementation emits one `--allowed-host` (singular) flag per host,
    // not a single `--allowed-hosts` flag — adjusted from the brief.
    const args = buildMcpServeArgs({
      host: '127.0.0.1',
      port: 3939,
      allowedHosts: ['myhost'],
    });
    assert.ok(args.includes('--allowed-host'));
    assert.ok(args.includes('myhost'));
  });

  it('includes allow-any-host flag when set', () => {
    const args = buildMcpServeArgs({
      host: '127.0.0.1',
      port: 3939,
      allowAnyHost: true,
    });
    assert.ok(args.includes('--allow-any-host'));
  });
});

describe('healthMatchesState — edge cases', () => {
  const state: McpState = {
    pid: 12345,
    host: '127.0.0.1',
    port: 3939,
    url: 'http://127.0.0.1:3939/mcp',
    healthUrl: 'http://127.0.0.1:3939/health',
    logPath: '/tmp/mcp.log',
    vaultPath: '/vault',
    startedAt: '2026-01-01T00:00:00Z',
  };

  it('returns true for matching vaultPath', () => {
    // healthMatchesState also checks name/transport/healthUrl identity, not
    // just vaultPath — adjusted from the brief to include the full identity.
    assert.equal(
      healthMatchesState(state, {
        ok: true,
        name: 'obsidian-hybrid-search',
        transport: 'streamable-http',
        vaultPath: '/vault',
      }),
      true,
    );
  });

  it('returns false for mismatched vaultPath', () => {
    assert.equal(
      healthMatchesState(state, {
        ok: true,
        name: 'obsidian-hybrid-search',
        transport: 'streamable-http',
        vaultPath: '/different',
      }),
      false,
    );
  });

  it('returns false for null healthInfo', () => {
    assert.equal(healthMatchesState(state, null), false);
  });
});

// Sanity check that buildMcpUrls is exported and behaves as expected.
describe('buildMcpUrls — edge cases', () => {
  it('builds mcp and health URLs', () => {
    assert.deepEqual(buildMcpUrls('127.0.0.1', 3939), {
      url: 'http://127.0.0.1:3939/mcp',
      healthUrl: 'http://127.0.0.1:3939/health',
    });
  });
});
