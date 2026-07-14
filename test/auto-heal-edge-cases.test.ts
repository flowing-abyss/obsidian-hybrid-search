import assert from 'node:assert/strict';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'vitest';
import {
  getNativeHealCacheDir,
  getNativeHealMarkerScope,
  getOrCreateInstallInstanceId,
  isLikelyAbiFailure,
  tryAutoHealAbiMismatch,
  type AutoHealDeps,
  type InstallInstanceDeps,
} from '../src/auto-heal';

const INSTALL_INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const WINNING_INSTALL_INSTANCE_ID = '22222222-2222-4222-8222-222222222222';
const INSTALL_INSTANCE_FILE = '.obsidian-hybrid-search-install-instance';

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
let removeStaleBinaryCalls: string[] = [];

function deps(overrides: Partial<AutoHealDeps> = {}): AutoHealDeps {
  return {
    cacheDir,
    platform: 'darwin',
    runtimeAbi: '127',
    now: () => 12345,
    pid: 999,
    resolveInstallInstanceId: () => INSTALL_INSTANCE_ID,
    resolveNativeModuleRoot: () => nativeModuleRoot,
    removeStaleBinary: (module) => {
      removeStaleBinaryCalls.push(module);
    },
    runInstallScript: (options) => {
      installCalls.push(options);
      return { status: 0 };
    },
    ...overrides,
  };
}

function installInstanceDeps(overrides: Partial<InstallInstanceDeps> = {}): InstallInstanceDeps {
  return {
    pid: 999,
    randomUUID: () => INSTALL_INSTANCE_ID,
    readFileSync: (filePath) => readFileSync(filePath, 'utf-8'),
    openSync: (filePath) => openSync(filePath, 'wx'),
    writeSync,
    fsyncSync,
    closeSync,
    linkSync,
    unlinkSync,
    ...overrides,
  };
}

beforeEach(() => {
  cacheDir = mkdtempSync(path.join(tmpdir(), 'ohs-auto-heal-edge-cache-'));
  projectRoot = mkdtempSync(path.join(tmpdir(), 'ohs-auto-heal-edge-project-'));
  nativeModuleRoot = path.join(projectRoot, 'node_modules', 'better-sqlite3');
  installCalls = [];
  removeStaleBinaryCalls = [];
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('tryAutoHealAbiMismatch — edge cases', () => {
  it('writes the retry marker before invoking the install script', () => {
    const marker = path.join(
      cacheDir,
      `abi-heal-attempted-better-sqlite3-127-${getNativeHealMarkerScope(INSTALL_INSTANCE_ID)}`,
    );
    let markerSeenByRunner = '';

    tryAutoHealAbiMismatch(
      'NODE_MODULE_VERSION mismatch',
      'better-sqlite3',
      deps({
        runInstallScript: () => {
          markerSeenByRunner = readFileSync(marker, 'utf-8');
          return { status: 0 };
        },
      }),
    );

    assert.match(markerSeenByRunner, /NODE_MODULE_VERSION mismatch/);
    assert.equal(existsSync(marker), true);
  });

  it('calls removeStaleBinary before running install', () => {
    const events: string[] = [];
    tryAutoHealAbiMismatch(
      'ABI mismatch',
      'better-sqlite3',
      deps({
        removeStaleBinary: () => events.push('remove'),
        runInstallScript: () => {
          events.push('install');
          return { status: 0 };
        },
      }),
    );
    assert.deepEqual(events, ['remove', 'install']);
  });

  it('does not call removeStaleBinary when marker already exists', () => {
    const marker = path.join(
      cacheDir,
      `abi-heal-attempted-better-sqlite3-127-${getNativeHealMarkerScope(INSTALL_INSTANCE_ID)}`,
    );
    writeFileSync(marker, 'previous failure');

    assert.throws(() => tryAutoHealAbiMismatch('ABI mismatch', 'better-sqlite3', deps()));
    assert.deepEqual(removeStaleBinaryCalls, []);
    assert.deepEqual(installCalls, []);
  });

  it('consumes eligibility when a pre-spawn action crashes after marker creation', () => {
    assert.throws(
      () =>
        tryAutoHealAbiMismatch(
          'ABI mismatch',
          'better-sqlite3',
          deps({
            removeStaleBinary: () => {
              throw new Error('simulated pre-spawn crash');
            },
          }),
        ),
      /simulated pre-spawn crash/,
    );

    assert.throws(
      () => tryAutoHealAbiMismatch('ABI mismatch', 'better-sqlite3', deps()),
      /already attempted/i,
    );
    assert.deepEqual(installCalls, []);
  });

  it('preserves the marker and reports the log when the install runner throws', () => {
    assert.throws(
      () =>
        tryAutoHealAbiMismatch(
          'ABI mismatch',
          'better-sqlite3',
          deps({
            runInstallScript: () => {
              throw new Error('spawn failed');
            },
          }),
        ),
      /spawn failed.*Install log:/is,
    );
    const marker = path.join(
      cacheDir,
      `abi-heal-attempted-better-sqlite3-127-${getNativeHealMarkerScope(INSTALL_INSTANCE_ID)}`,
    );
    assert.equal(existsSync(marker), true);
  });

  it('sqlite-vec returns manual instructions without spawning', () => {
    let installInstanceResolutions = 0;
    assert.throws(
      () =>
        tryAutoHealAbiMismatch(
          'Cannot find module sqlite-vec',
          'sqlite-vec',
          deps({
            resolveInstallInstanceId: () => {
              installInstanceResolutions++;
              return INSTALL_INSTANCE_ID;
            },
          }),
        ),
      /sqlite-vec.*manual/i,
    );
    assert.equal(installInstanceResolutions, 0);
    assert.deepEqual(installCalls, []);
    assert.deepEqual(removeStaleBinaryCalls, []);
  });
});

describe('getOrCreateInstallInstanceId — publication failures', () => {
  function sentinelPath(): string {
    return path.join(nativeModuleRoot, INSTALL_INSTANCE_FILE);
  }

  beforeEach(() => {
    // The package root exists before recovery; only the sentinel is absent.
    mkdirSync(nativeModuleRoot, { recursive: true });
  });

  it('rejects an empty final sentinel without rewriting it', () => {
    writeFileSync(sentinelPath(), '');

    assert.throws(() => getOrCreateInstallInstanceId(nativeModuleRoot), /invalid.*UUID/i);
    assert.equal(readFileSync(sentinelPath(), 'utf-8'), '');
  });

  it('rejects invalid UUID text without rewriting it', () => {
    writeFileSync(sentinelPath(), 'not-a-uuid');

    assert.throws(() => getOrCreateInstallInstanceId(nativeModuleRoot), /invalid.*UUID/i);
    assert.equal(readFileSync(sentinelPath(), 'utf-8'), 'not-a-uuid');
  });

  it('propagates final sentinel read failures without rewriting it', () => {
    writeFileSync(sentinelPath(), INSTALL_INSTANCE_ID);
    const deps = installInstanceDeps({
      readFileSync: () => {
        const error = new Error('sentinel read denied') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      },
    });

    assert.throws(
      () => getOrCreateInstallInstanceId(nativeModuleRoot, deps),
      /sentinel read denied/,
    );
    assert.equal(readFileSync(sentinelPath(), 'utf-8'), INSTALL_INSTANCE_ID);
  });

  it('propagates temporary-file creation failures without creating a final sentinel', () => {
    const deps = installInstanceDeps({
      openSync: () => {
        throw new Error('temporary creation denied');
      },
    });

    assert.throws(
      () => getOrCreateInstallInstanceId(nativeModuleRoot, deps),
      /temporary creation denied/,
    );
    assert.equal(existsSync(sentinelPath()), false);
  });

  it('propagates non-EEXIST link failures and removes the temporary file', () => {
    const deps = installInstanceDeps({
      linkSync: () => {
        const error = new Error('hard-link denied') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      },
    });

    assert.throws(() => getOrCreateInstallInstanceId(nativeModuleRoot, deps), /hard-link denied/);
    assert.equal(existsSync(sentinelPath()), false);
    assert.deepEqual(readdirSync(nativeModuleRoot), []);
  });

  it('preserves the primary publication error when temporary cleanup fails', () => {
    const deps = installInstanceDeps({
      linkSync: () => {
        const error = new Error('primary hard-link failure') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      },
      unlinkSync: () => {
        throw new Error('secondary cleanup failure');
      },
    });

    assert.throws(
      () => getOrCreateInstallInstanceId(nativeModuleRoot, deps),
      /primary hard-link failure/,
    );
  });

  it('publishes the complete UUID across short writes', () => {
    const deps = installInstanceDeps({
      writeSync: (fd, value) => writeSync(fd, value.slice(0, 5)),
    });

    assert.equal(getOrCreateInstallInstanceId(nativeModuleRoot, deps), INSTALL_INSTANCE_ID);
    assert.equal(readFileSync(sentinelPath(), 'utf-8'), INSTALL_INSTANCE_ID);
  });

  it('keeps a successful publication when temporary cleanup fails', () => {
    const deps = installInstanceDeps({
      unlinkSync: () => {
        throw new Error('temporary cleanup failed');
      },
    });

    assert.equal(getOrCreateInstallInstanceId(nativeModuleRoot, deps), INSTALL_INSTANCE_ID);
    assert.equal(readFileSync(sentinelPath(), 'utf-8'), INSTALL_INSTANCE_ID);
  });

  it('adopts a valid winner when publication loses with EEXIST', () => {
    const deps = installInstanceDeps({
      linkSync: (_temporaryPath, finalPath) => {
        writeFileSync(finalPath, WINNING_INSTALL_INSTANCE_ID);
        const error = new Error('winner published') as NodeJS.ErrnoException;
        error.code = 'EEXIST';
        throw error;
      },
    });

    assert.equal(getOrCreateInstallInstanceId(nativeModuleRoot, deps), WINNING_INSTALL_INSTANCE_ID);
    assert.equal(readFileSync(sentinelPath(), 'utf-8'), WINNING_INSTALL_INSTANCE_ID);
    assert.deepEqual(readdirSync(nativeModuleRoot), [INSTALL_INSTANCE_FILE]);
  });

  it('rejects an invalid EEXIST winner without rewriting it', () => {
    const deps = installInstanceDeps({
      linkSync: (_temporaryPath, finalPath) => {
        writeFileSync(finalPath, 'invalid-winner');
        const error = new Error('winner published') as NodeJS.ErrnoException;
        error.code = 'EEXIST';
        throw error;
      },
    });

    assert.throws(() => getOrCreateInstallInstanceId(nativeModuleRoot, deps), /invalid.*UUID/i);
    assert.equal(readFileSync(sentinelPath(), 'utf-8'), 'invalid-winner');
    assert.deepEqual(readdirSync(nativeModuleRoot), [INSTALL_INSTANCE_FILE]);
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

describe('getNativeHealMarkerScope — validation', () => {
  it('rejects malformed installation UUIDs', () => {
    assert.throws(() => getNativeHealMarkerScope('not-a-uuid'), /invalid.*UUID/i);
  });
});
