import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'vitest';
import {
  clearNativeHealMarkers,
  getNativeHealCacheDir,
  getNativeHealMarkerScope,
  isLikelyAbiFailure,
  tryAutoHealAbiMismatch,
  type AutoHealDeps,
} from '../src/auto-heal';

let cacheDir: string;
let projectRoot: string;
let spawnCalls: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
let removeStaleBinaryCalls: string[] = [];

function deps(overrides: Partial<AutoHealDeps> = {}): AutoHealDeps {
  return {
    cacheDir,
    platform: 'darwin',
    arch: 'arm64',
    runtimeAbi: '127',
    markerScope: 'darwin-arm64-test-install',
    now: () => 12345,
    pid: 999,
    resolveProjectRoot: () => projectRoot,
    removeStaleBinary: (module) => {
      removeStaleBinaryCalls.push(module);
    },
    spawnDetached: (command, args, options) => {
      spawnCalls.push({ command, args, cwd: options.cwd });
      return { pid: 4242 };
    },
    ...overrides,
  };
}

beforeEach(() => {
  cacheDir = mkdtempSync(path.join(tmpdir(), 'ohs-auto-heal-edge-cache-'));
  projectRoot = mkdtempSync(path.join(tmpdir(), 'ohs-auto-heal-edge-project-'));
  spawnCalls = [];
  removeStaleBinaryCalls = [];
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('tryAutoHealAbiMismatch — edge cases', () => {
  it('writes retry marker before spawning', () => {
    assert.throws(
      () => tryAutoHealAbiMismatch('NODE_MODULE_VERSION mismatch', 'better-sqlite3', deps()),
      /rebuild started.*PID 4242/i,
    );
    // Marker should exist
    const marker = path.join(
      cacheDir,
      'abi-heal-attempted-better-sqlite3-127-darwin-arm64-test-install',
    );
    assert.equal(existsSync(marker), true);
    assert.match(readFileSync(marker, 'utf-8'), /NODE_MODULE_VERSION mismatch/);
  });

  it('calls removeStaleBinary before spawning', () => {
    assert.throws(() => tryAutoHealAbiMismatch('ABI mismatch', 'better-sqlite3', deps()));
    assert.deepEqual(removeStaleBinaryCalls, ['better-sqlite3']);
  });

  it('does not call removeStaleBinary when marker already exists', () => {
    // First call creates marker
    assert.throws(() => tryAutoHealAbiMismatch('ABI mismatch', 'better-sqlite3', deps()));
    removeStaleBinaryCalls = [];
    spawnCalls = [];

    // Second call should not remove stale binary or spawn (marker already exists)
    assert.throws(() => tryAutoHealAbiMismatch('ABI mismatch', 'better-sqlite3', deps()));
    assert.deepEqual(removeStaleBinaryCalls, []);
    assert.deepEqual(spawnCalls, []);
  });

  it('includes pid in error message when spawnDetached returns pid', () => {
    assert.throws(
      () => tryAutoHealAbiMismatch('ABI mismatch', 'better-sqlite3', deps()),
      /PID 4242/,
    );
  });

  it('omits pid suffix when spawnDetached returns no pid', () => {
    assert.throws(
      () =>
        tryAutoHealAbiMismatch('ABI mismatch', 'better-sqlite3', {
          ...deps(),
          spawnDetached: () => ({}),
        }),
      (err: Error) => !err.message.includes('PID'),
    );
  });

  it('sqlite-vec returns manual instructions without spawning', () => {
    assert.throws(
      () => tryAutoHealAbiMismatch('Cannot find module sqlite-vec', 'sqlite-vec', deps()),
      /sqlite-vec.*manual/i,
    );
    assert.deepEqual(spawnCalls, []);
    assert.deepEqual(removeStaleBinaryCalls, []);
  });

  it('Windows returns manual instructions without spawning', () => {
    assert.throws(
      () =>
        tryAutoHealAbiMismatch('ABI mismatch', 'better-sqlite3', {
          ...deps(),
          platform: 'win32',
        }),
      /disabled on Windows/i,
    );
    assert.deepEqual(spawnCalls, []);
  });
});

describe('clearNativeHealMarkers — edge cases', () => {
  it('removes existing marker without error', () => {
    const marker = path.join(
      cacheDir,
      'abi-heal-attempted-better-sqlite3-127-darwin-arm64-test-install',
    );
    writeFileSync(marker, 'exists');
    clearNativeHealMarkers(['better-sqlite3'], '127', 'darwin-arm64-test-install', cacheDir);
    assert.equal(existsSync(marker), false);
  });

  it('does not error when marker does not exist', () => {
    // Should not throw
    clearNativeHealMarkers(['better-sqlite3'], '127', 'darwin-arm64-test-install', cacheDir);
    const marker = path.join(
      cacheDir,
      'abi-heal-attempted-better-sqlite3-127-darwin-arm64-test-install',
    );
    assert.equal(existsSync(marker), false);
  });

  it('handles multiple modules', () => {
    const markerBs = path.join(
      cacheDir,
      'abi-heal-attempted-better-sqlite3-127-darwin-arm64-test-install',
    );
    const markerSv = path.join(
      cacheDir,
      'abi-heal-attempted-sqlite-vec-127-darwin-arm64-test-install',
    );
    writeFileSync(markerBs, 'exists');
    writeFileSync(markerSv, 'exists');
    clearNativeHealMarkers(
      ['better-sqlite3', 'sqlite-vec'],
      '127',
      'darwin-arm64-test-install',
      cacheDir,
    );
    assert.equal(existsSync(markerBs), false);
    assert.equal(existsSync(markerSv), false);
  });
});

describe('getNativeHealCacheDir — edge cases', () => {
  const originalXdg = process.env.XDG_CACHE_HOME;

  afterEach(() => {
    if (originalXdg === undefined) {
      delete process.env.XDG_CACHE_HOME;
    } else {
      process.env.XDG_CACHE_HOME = originalXdg;
    }
  });

  it('uses XDG_CACHE_HOME when set', () => {
    const tempCache = mkdtempSync(path.join(tmpdir(), 'ohs-cache-test-'));
    process.env.XDG_CACHE_HOME = tempCache;
    const dir = getNativeHealCacheDir();
    assert.equal(dir, path.join(tempCache, 'obsidian-hybrid-search'));
    rmSync(tempCache, { recursive: true, force: true });
  });

  it('falls back to ~/.cache when XDG_CACHE_HOME unset', () => {
    delete process.env.XDG_CACHE_HOME;
    const dir = getNativeHealCacheDir();
    assert.ok(dir.includes('obsidian-hybrid-search'));
  });
});

describe('isLikelyAbiFailure — additional edge cases', () => {
  it('matches "was compiled against a different Node.js"', () => {
    assert.equal(isLikelyAbiFailure('was compiled against a different Node.js version'), true);
  });

  it('matches "NODE_MODULE_VERSION"', () => {
    assert.equal(isLikelyAbiFailure('NODE_MODULE_VERSION 115 expected 127'), true);
  });

  it('does not match regular vault errors', () => {
    assert.equal(isLikelyAbiFailure('vault path not found'), false);
  });

  it('does not match empty string', () => {
    assert.equal(isLikelyAbiFailure(''), false);
  });
});

// Reference import to exercise the default-scope code path without discarding the binding.
describe('getNativeHealMarkerScope — default identity', () => {
  it('produces a platform-arch-hash scope string', () => {
    const scope = getNativeHealMarkerScope('/tmp/edge-project', 'linux', 'x64', {
      appVersion: '0.0.0',
      nativeVersions: { 'better-sqlite3': '1.0.0', 'sqlite-vec': '0.1.0' },
    });
    assert.match(scope, /^linux-x64-[a-f0-9]{16}$/);
  });
});
