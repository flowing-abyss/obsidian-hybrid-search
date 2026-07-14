import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, it } from 'vitest';

const WORKER_COUNT = 8;
const INSTALL_INSTANCE_FILE = '.obsidian-hybrid-search-install-instance';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AUTO_HEAL_URL = pathToFileURL(path.resolve('src/auto-heal.ts')).href;

interface WorkerOutput {
  status: 'success' | 'already-attempted';
  installInstanceId?: string;
}

const sentinelWorkerSource = String.raw`
const [autoHealUrl, moduleRoot] = process.argv.slice(1);
const { getOrCreateInstallInstanceId } = await import(autoHealUrl);
const installInstanceId = getOrCreateInstallInstanceId(moduleRoot);
process.stdout.write(JSON.stringify({ status: 'success', installInstanceId }));
`;

const recoveryWorkerSource = String.raw`
const [autoHealUrl, moduleRoot, cacheDir, runnerDir, runtimeAbi] = process.argv.slice(1);
const { writeFileSync } = await import('node:fs');
const { join } = await import('node:path');
const { getOrCreateInstallInstanceId, tryAutoHealAbiMismatch } = await import(autoHealUrl);

try {
  tryAutoHealAbiMismatch('NODE_MODULE_VERSION mismatch', 'better-sqlite3', {
    cacheDir,
    platform: process.platform,
    runtimeAbi,
    now: () => 0,
    pid: process.pid,
    resolveInstallInstanceId: () => getOrCreateInstallInstanceId(moduleRoot),
    resolveNativeModuleRoot: () => moduleRoot,
    removeStaleBinary: () => {},
    runInstallScript: () => {
      writeFileSync(join(runnerDir, 'runner-' + process.pid), '', { flag: 'wx' });
      return { status: 0 };
    },
  });
  process.stdout.write(JSON.stringify({ status: 'success' }));
} catch (error) {
  if (error instanceof Error && /already attempted/i.test(error.message)) {
    process.stdout.write(JSON.stringify({ status: 'already-attempted' }));
  } else {
    throw error;
  }
}
`;

const temporaryRoots: string[] = [];

function createTemporaryRoot(name: string): string {
  const root = mkdtempSync(path.join(tmpdir(), name));
  temporaryRoots.push(root);
  return root;
}

function launchWorker(workerSource: string, args: readonly string[]): Promise<WorkerOutput> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', '-e', workerSource, ...args],
      { encoding: 'utf-8' },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`worker failed: ${stderr || error.message}`));
          return;
        }

        try {
          resolve(JSON.parse(stdout) as WorkerOutput);
        } catch (parseError) {
          reject(
            new Error(`worker returned malformed output ${JSON.stringify(stdout)}`, {
              cause: parseError,
            }),
          );
        }
      },
    );
  });
}

async function runWorkers(workerSource: string, args: readonly string[]): Promise<WorkerOutput[]> {
  const settled = await Promise.allSettled(
    Array.from({ length: WORKER_COUNT }, () => launchWorker(workerSource, args)),
  );
  const failures = settled.filter((result) => result.status === 'rejected');

  assert.deepEqual(failures, []);
  return settled.map((result) => {
    assert.equal(result.status, 'fulfilled');
    return result.value;
  });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('auto-heal cross-process exclusion', () => {
  it('publishes one complete install-instance UUID for concurrent creators', async () => {
    const root = createTemporaryRoot('ohs-auto-heal-sentinel-');
    const moduleRoot = path.join(root, 'module');
    mkdirSync(moduleRoot);

    const outputs = await runWorkers(sentinelWorkerSource, [AUTO_HEAL_URL, moduleRoot]);
    const installInstanceIds = outputs.map((output) => output.installInstanceId);
    const sentinelPath = path.join(moduleRoot, INSTALL_INSTANCE_FILE);

    assert.equal(new Set(installInstanceIds).size, 1);
    assert.match(installInstanceIds[0] ?? '', UUID_RE);
    assert.equal(readFileSync(sentinelPath, 'utf-8'), installInstanceIds[0]);
    assert.deepEqual(readdirSync(moduleRoot), [INSTALL_INSTANCE_FILE]);
  }, 30_000);

  it('allows at most one recovery runner for one install instance and ABI', async () => {
    const root = createTemporaryRoot('ohs-auto-heal-recovery-');
    const moduleRoot = path.join(root, 'module');
    const cacheDir = path.join(root, 'cache');
    const runnerDir = path.join(root, 'runners');
    const runtimeAbi = 'cross-process-test-abi';
    mkdirSync(moduleRoot);
    mkdirSync(runnerDir);

    const outputs = await runWorkers(recoveryWorkerSource, [
      AUTO_HEAL_URL,
      moduleRoot,
      cacheDir,
      runnerDir,
      runtimeAbi,
    ]);
    const successfulWorkers = outputs.filter((output) => output.status === 'success');
    const losingWorkers = outputs.filter((output) => output.status === 'already-attempted');
    const runnerFiles = readdirSync(runnerDir).filter((name) => name.startsWith('runner-'));

    assert.equal(successfulWorkers.length, 1);
    assert.equal(losingWorkers.length, WORKER_COUNT - 1);
    assert.equal(runnerFiles.length, successfulWorkers.length);
    assert.ok(runnerFiles.length <= 1);
  }, 30_000);
});
