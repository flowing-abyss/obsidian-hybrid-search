import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'vitest';
import {
  getNativeHealMarkerScope,
  getOrCreateInstallInstanceId,
  isLikelyAbiFailure,
  tryAutoHealAbiMismatch,
  type AutoHealDeps,
} from '../src/auto-heal';

const INSTALL_INSTANCE_ID = '11111111-1111-4111-8111-111111111111';

let cacheDir: string;
let projectRoot: string;
let nativeModuleRoot: string;
let installCalls: Array<{
  command: string;
  args: readonly string[];
  cwd: string;
  logPath: string;
  shell: boolean;
}> = [];

function deps(overrides: Partial<AutoHealDeps> = {}): AutoHealDeps {
  return {
    cacheDir,
    platform: 'darwin',
    runtimeAbi: '127',
    now: () => 12345,
    pid: 999,
    resolveInstallInstanceId: () => INSTALL_INSTANCE_ID,
    resolveNativeModuleRoot: () => nativeModuleRoot,
    removeStaleBinary: () => {},
    runInstallScript: (options) => {
      installCalls.push(options);
      return { status: 0 };
    },
    ...overrides,
  };
}

beforeEach(() => {
  cacheDir = mkdtempSync(path.join(tmpdir(), 'ohs-auto-heal-cache-'));
  projectRoot = mkdtempSync(path.join(tmpdir(), 'ohs-auto-heal-project-'));
  nativeModuleRoot = path.join(projectRoot, 'node_modules', 'better-sqlite3');
  installCalls = [];
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
  it('is deterministic for one installation UUID and changes for another UUID', () => {
    const idA = '11111111-1111-4111-8111-111111111111';
    const idB = '22222222-2222-4222-8222-222222222222';

    assert.equal(getNativeHealMarkerScope(idA), getNativeHealMarkerScope(idA));
    assert.notEqual(getNativeHealMarkerScope(idA), getNativeHealMarkerScope(idB));
    assert.match(getNativeHealMarkerScope(idA), /^[a-f0-9]{16}$/);
  });
});

describe('getOrCreateInstallInstanceId', () => {
  it('publishes one canonical UUID and returns it on repeated reads', () => {
    const first = getOrCreateInstallInstanceId(projectRoot);
    const second = getOrCreateInstallInstanceId(projectRoot);
    const sentinel = path.join(projectRoot, '.obsidian-hybrid-search-install-instance');

    assert.match(
      first,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    assert.equal(second, first);
    assert.equal(readFileSync(sentinel, 'utf-8'), first);
  });

  it('publishes a new UUID after the sentinel is deleted', () => {
    const sentinel = path.join(projectRoot, '.obsidian-hybrid-search-install-instance');
    const first = getOrCreateInstallInstanceId(projectRoot);

    unlinkSync(sentinel);

    const second = getOrCreateInstallInstanceId(projectRoot);
    assert.notEqual(second, first);
    assert.equal(readFileSync(sentinel, 'utf-8'), second);
  });
});

describe('tryAutoHealAbiMismatch', () => {
  it('runs the dependency install synchronously and keeps its marker permanently', () => {
    assert.doesNotThrow(() =>
      tryAutoHealAbiMismatch(
        'NODE_MODULE_VERSION mismatch',
        'better-sqlite3',
        deps({
          runInstallScript: (options) => {
            installCalls.push(options);
            writeFileSync(options.logPath, 'successful install output');
            return { status: 0 };
          },
        }),
      ),
    );

    assert.equal(installCalls.length, 1);
    assert.equal(installCalls[0]?.command, 'npm');
    assert.deepEqual(installCalls[0]?.args, ['run', 'install']);
    assert.equal(installCalls[0]?.cwd, nativeModuleRoot);
    assert.match(installCalls[0]?.logPath ?? '', /better-sqlite3-install-12345-999\.log$/);
    assert.equal(existsSync(installCalls[0]?.logPath ?? ''), false);
    const marker = path.join(
      cacheDir,
      `abi-heal-attempted-better-sqlite3-127-${getNativeHealMarkerScope(INSTALL_INSTANCE_ID)}`,
    );
    assert.equal(existsSync(marker), true);
  });

  it('leaves the marker and reports the install log when install fails', () => {
    assert.throws(
      () =>
        tryAutoHealAbiMismatch(
          'NODE_MODULE_VERSION mismatch',
          'better-sqlite3',
          deps({
            runInstallScript: (options) => {
              installCalls.push(options);
              return { status: 1 };
            },
          }),
        ),
      /native install failed.*status 1.*Install log:/is,
    );

    const marker = path.join(
      cacheDir,
      `abi-heal-attempted-better-sqlite3-127-${getNativeHealMarkerScope(INSTALL_INSTANCE_ID)}`,
    );
    assert.equal(existsSync(marker), true);
    assert.equal(installCalls.length, 1);
  });

  it('treats an existing marker as already attempted without spawning', () => {
    const marker = path.join(
      cacheDir,
      `abi-heal-attempted-better-sqlite3-127-${getNativeHealMarkerScope(INSTALL_INSTANCE_ID)}`,
    );
    writeFileSync(marker, 'already here');

    assert.throws(
      () => tryAutoHealAbiMismatch('NODE_MODULE_VERSION mismatch', 'better-sqlite3', deps()),
      /already attempted.*npm run install/i,
    );

    assert.deepEqual(installCalls, []);
  });

  it('does not auto-install sqlite-vec and returns manual instructions', () => {
    assert.throws(
      () => tryAutoHealAbiMismatch('Cannot find module sqlite-vec', 'sqlite-vec', deps()),
      /sqlite-vec.*manual.*npm install/i,
    );

    assert.deepEqual(installCalls, []);
  });

  it('uses the synchronous install runner on Windows', () => {
    assert.doesNotThrow(() =>
      tryAutoHealAbiMismatch('NODE_MODULE_VERSION mismatch', 'better-sqlite3', {
        ...deps(),
        platform: 'win32',
      }),
    );

    assert.equal(installCalls.length, 1);
    assert.equal(installCalls[0]?.cwd, nativeModuleRoot);
    assert.equal(installCalls[0]?.shell, true);
  });
});
