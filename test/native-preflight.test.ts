import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'vitest';
import {
  loadNativeModuleWithRequire,
  runNativeModulePreflight,
  type NativePreflightDeps,
} from '../src/native-preflight';

let cacheDir: string;
let stderr = '';
let exits: number[] = [];

function deps(overrides: Partial<NativePreflightDeps> = {}): NativePreflightDeps {
  return {
    cacheDir,
    runtimeVersion: 'v25.1.0',
    runtimeAbi: '127',
    platform: 'darwin',
    arch: 'arm64',
    modules: ['better-sqlite3', 'sqlite-vec'],
    loadNativeModule: () => {},
    writeStderrSync: (message) => {
      stderr += message;
    },
    exit: (code) => {
      exits.push(code);
      throw new Error(`exit ${code}`);
    },
    handleAbiFailure: () => {
      throw new Error('native recovery failed');
    },
    ...overrides,
  };
}

beforeEach(() => {
  cacheDir = mkdtempSync(path.join(tmpdir(), 'ohs-preflight-cache-'));
  stderr = '';
  exits = [];
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

describe('runNativeModulePreflight', () => {
  it('stays quiet and leaves existing recovery state untouched after successful loads', () => {
    const marker = path.join(cacheDir, 'abi-heal-attempted-better-sqlite3-127-undefined');
    writeFileSync(marker, 'old failure');

    runNativeModulePreflight(deps());

    assert.equal(stderr, '');
    assert.equal(existsSync(marker), true);
    assert.deepEqual(exits, []);
  });

  it('loads healthy modules without creating or consulting recovery state', () => {
    rmSync(cacheDir, { recursive: true, force: true });
    const loadCalls: string[] = [];

    runNativeModulePreflight(
      deps({
        loadNativeModule: (moduleName) => loadCalls.push(moduleName),
        handleAbiFailure: () => {
          throw new Error('healthy preflight called recovery');
        },
      }),
    );

    assert.deepEqual(loadCalls, ['better-sqlite3', 'sqlite-vec']);
    assert.equal(stderr, '');
    assert.deepEqual(exits, []);
    assert.equal(existsSync(cacheDir), false);
  });

  it('retries a repaired native module and continues in the same process', () => {
    const loadCalls: string[] = [];
    const healCalls: Array<{ message: string; moduleName: string }> = [];

    runNativeModulePreflight(
      deps({
        loadNativeModule: (moduleName) => {
          loadCalls.push(moduleName);
          if (moduleName === 'better-sqlite3' && loadCalls.length === 1) {
            throw new Error('Could not locate the bindings file');
          }
        },
        handleAbiFailure: (message, moduleName) => {
          healCalls.push({ message, moduleName });
        },
      }),
    );

    assert.deepEqual(loadCalls, ['better-sqlite3', 'better-sqlite3', 'sqlite-vec']);
    assert.deepEqual(healCalls, [
      { message: 'Could not locate the bindings file', moduleName: 'better-sqlite3' },
    ]);
    assert.deepEqual(exits, []);
    assert.equal(stderr, '');
    assert.equal(existsSync(path.join(cacheDir, 'last-startup-error.log')), false);
  });

  it('records native module failures, runs ABI handler, and exits with code 1', () => {
    assert.throws(
      () =>
        runNativeModulePreflight(
          deps({
            loadNativeModule: (moduleName) => {
              if (moduleName === 'better-sqlite3') {
                throw new Error('NODE_MODULE_VERSION mismatch');
              }
            },
          }),
        ),
      /exit 1/,
    );

    assert.deepEqual(exits, [1]);
    assert.match(stderr, /Native module failed: better-sqlite3/);
    assert.match(stderr, /NODE_MODULE_VERSION mismatch/);
    assert.match(stderr, /native recovery failed/);

    const log = readFileSync(path.join(cacheDir, 'last-startup-error.log'), 'utf-8');
    assert.match(log, /module: better-sqlite3/);
    assert.match(log, /abi: 127/);
    assert.match(log, /NODE_MODULE_VERSION mismatch/);
    assert.match(log, /native recovery failed/);
  });

  it('records a failed reload after the repair command succeeds', () => {
    let loadAttempts = 0;
    const marker = path.join(cacheDir, 'abi-heal-attempted-better-sqlite3-127-reload-test');

    assert.throws(
      () =>
        runNativeModulePreflight(
          deps({
            loadNativeModule: (moduleName) => {
              if (moduleName !== 'better-sqlite3') return;
              loadAttempts++;
              throw new Error(
                loadAttempts === 1
                  ? 'Could not locate the bindings file'
                  : 'binding still missing after install',
              );
            },
            handleAbiFailure: () => {
              writeFileSync(marker, 'attempt consumed');
            },
          }),
        ),
      /exit 1/,
    );

    assert.equal(loadAttempts, 2);
    assert.deepEqual(exits, [1]);
    assert.match(stderr, /Could not locate the bindings file/);
    assert.match(stderr, /binding still missing after install/);
    const log = readFileSync(path.join(cacheDir, 'last-startup-error.log'), 'utf-8');
    assert.match(log, /Could not locate the bindings file/);
    assert.match(log, /binding still missing after install/);
    assert.equal(existsSync(marker), true);
  });

  it('writes manual recovery for sqlite-vec failures even when they are not ABI-shaped', () => {
    assert.throws(
      () =>
        runNativeModulePreflight(
          deps({
            loadNativeModule: (moduleName) => {
              if (moduleName === 'sqlite-vec') {
                throw new Error('extension entrypoint missing');
              }
            },
            handleAbiFailure: (message, moduleName) => {
              throw new Error(`manual recovery for ${moduleName}: ${message}`);
            },
          }),
        ),
      /exit 1/,
    );

    assert.match(stderr, /manual recovery for sqlite-vec: extension entrypoint missing/);
    const log = readFileSync(path.join(cacheDir, 'last-startup-error.log'), 'utf-8');
    assert.match(log, /module: sqlite-vec/);
    assert.match(log, /manual recovery for sqlite-vec: extension entrypoint missing/);
  });
});

describe('loadNativeModuleWithRequire', () => {
  it('constructs an in-memory better-sqlite3 database to force native binding load', () => {
    const calls: string[] = [];
    const requireModule = (moduleName: string): unknown => {
      assert.equal(moduleName, 'better-sqlite3');
      return class FakeDatabase {
        constructor(filename: string) {
          calls.push(filename);
        }

        close(): void {
          calls.push('close');
        }
      };
    };

    loadNativeModuleWithRequire('better-sqlite3', requireModule);

    assert.deepEqual(calls, [':memory:', 'close']);
  });

  it('loads sqlite-vec into an in-memory better-sqlite3 database', () => {
    const calls: string[] = [];
    const db = { close: () => calls.push('close') };
    const requireModule = (moduleName: string): unknown => {
      if (moduleName === 'better-sqlite3') {
        return class FakeDatabase {
          constructor(filename: string) {
            calls.push(filename);
            return db;
          }
        };
      }
      if (moduleName === 'sqlite-vec') {
        return {
          load(value: unknown) {
            assert.equal(value, db);
            calls.push('load');
          },
        };
      }
      throw new Error(`Unexpected require: ${moduleName}`);
    };

    loadNativeModuleWithRequire('sqlite-vec', requireModule);

    assert.deepEqual(calls, [':memory:', 'load', 'close']);
  });

  it('surfaces constructor-time better-sqlite3 native failures', () => {
    const requireModule = (): unknown =>
      class FakeDatabase {
        constructor() {
          throw new Error('NODE_MODULE_VERSION constructor failure');
        }
      };

    assert.throws(
      () => loadNativeModuleWithRequire('better-sqlite3', requireModule),
      /constructor failure/,
    );
  });
});
