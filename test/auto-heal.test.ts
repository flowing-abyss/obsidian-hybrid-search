import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'vitest';
import {
  getNativeHealMarkerScope,
  isLikelyAbiFailure,
  tryAutoHealAbiMismatch,
  type AutoHealDeps,
} from '../src/auto-heal';

let cacheDir: string;
let projectRoot: string;
let spawnCalls: Array<{ command: string; args: readonly string[]; cwd: string }> = [];

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
    removeStaleBinary: () => {},
    spawnDetached: (command, args, options) => {
      spawnCalls.push({ command, args, cwd: options.cwd });
      return { pid: 4242 };
    },
    ...overrides,
  };
}

beforeEach(() => {
  cacheDir = mkdtempSync(path.join(tmpdir(), 'ohs-auto-heal-cache-'));
  projectRoot = mkdtempSync(path.join(tmpdir(), 'ohs-auto-heal-project-'));
  spawnCalls = [];
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('isLikelyAbiFailure', () => {
  it('matches native ABI and dlopen failures', () => {
    assert.equal(isLikelyAbiFailure('NODE_MODULE_VERSION 115 expected 127'), true);
    assert.equal(isLikelyAbiFailure('Error [ERR_DLOPEN_FAILED]: dlopen failed'), true);
    assert.equal(isLikelyAbiFailure('was compiled against a different Node.js version'), true);
    assert.equal(isLikelyAbiFailure('Could not locate the bindings file'), true);
    assert.equal(isLikelyAbiFailure('missing better_sqlite3.node'), true);
    assert.equal(isLikelyAbiFailure('regular missing vault configuration'), false);
  });
});

describe('getNativeHealMarkerScope', () => {
  it('includes install path, app version, and native package versions', () => {
    const scopeA = getNativeHealMarkerScope('/app', 'darwin', 'arm64', {
      appVersion: '1.0.0',
      nativeVersions: {
        'better-sqlite3': '12.0.0',
        'sqlite-vec': '0.1.0',
      },
    });
    const scopeB = getNativeHealMarkerScope('/app', 'darwin', 'arm64', {
      appVersion: '1.0.1',
      nativeVersions: {
        'better-sqlite3': '12.0.0',
        'sqlite-vec': '0.1.0',
      },
    });

    assert.notEqual(scopeA, scopeB);
    assert.match(scopeA, /^darwin-arm64-[a-f0-9]{16}$/);
  });
});

describe('tryAutoHealAbiMismatch', () => {
  it('starts one detached npm rebuild for better-sqlite3 and writes a retry marker first', () => {
    assert.throws(
      () => tryAutoHealAbiMismatch('NODE_MODULE_VERSION mismatch', 'better-sqlite3', deps()),
      /rebuild started.*PID 4242.*restart your MCP client/i,
    );

    assert.deepEqual(spawnCalls, [
      {
        command: 'npm',
        args: ['rebuild', 'better-sqlite3'],
        cwd: projectRoot,
      },
    ]);
    const marker = path.join(
      cacheDir,
      'abi-heal-attempted-better-sqlite3-127-darwin-arm64-test-install',
    );
    assert.equal(existsSync(marker), true);
    assert.match(readFileSync(marker, 'utf-8'), /NODE_MODULE_VERSION mismatch/);
  });

  it('does not retry better-sqlite3 rebuild when the marker already exists', () => {
    assert.throws(() =>
      tryAutoHealAbiMismatch('NODE_MODULE_VERSION mismatch', 'better-sqlite3', deps()),
    );
    spawnCalls = [];

    assert.throws(
      () => tryAutoHealAbiMismatch('NODE_MODULE_VERSION mismatch', 'better-sqlite3', deps()),
      /already attempted.*npm rebuild better-sqlite3/i,
    );

    assert.deepEqual(spawnCalls, []);
  });

  it('treats an existing marker as already attempted without spawning', () => {
    const marker = path.join(
      cacheDir,
      'abi-heal-attempted-better-sqlite3-127-darwin-arm64-test-install',
    );
    writeFileSync(marker, 'already here');

    assert.throws(
      () => tryAutoHealAbiMismatch('NODE_MODULE_VERSION mismatch', 'better-sqlite3', deps()),
      /already attempted.*npm rebuild better-sqlite3/i,
    );

    assert.deepEqual(spawnCalls, []);
  });

  it('does not auto-install sqlite-vec and returns manual instructions', () => {
    assert.throws(
      () => tryAutoHealAbiMismatch('Cannot find module sqlite-vec', 'sqlite-vec', deps()),
      /sqlite-vec.*manual.*npm install/i,
    );

    assert.deepEqual(spawnCalls, []);
  });

  it('does not auto-heal on Windows', () => {
    assert.throws(
      () =>
        tryAutoHealAbiMismatch('NODE_MODULE_VERSION mismatch', 'better-sqlite3', {
          ...deps(),
          platform: 'win32',
        }),
      /automatic rebuild is disabled on Windows/i,
    );

    assert.deepEqual(spawnCalls, []);
  });
});
