import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('../verify.mjs', import.meta.url));
const aggregator = fileURLToPath(new URL('../check-ci-results.mjs', import.meta.url));
const mandatory = [
  'format:check',
  'lint',
  'build',
  'knip',
  'test:ai',
  'test:tooling',
  'coverage',
  'test:e2e-watcher',
  'test:integration',
  'test:reranker',
  'test:native-recovery-smoke',
  'eval:quality',
];
function fixture(run) {
  const root = mkdtempSync(path.join(tmpdir(), 'ohs-gate-'));
  try {
    const npm = path.join(root, 'npm.cjs');
    const log = path.join(root, 'log');
    writeFileSync(
      npm,
      `const fs=require('node:fs'); fs.appendFileSync(process.env.GATE_LOG, process.argv[3]+'\\n'); if(process.argv[3]===process.env.GATE_FAIL) process.exit(37); if(process.argv[3]===process.env.GATE_CANCEL) process.kill(process.pid,'SIGTERM');`,
    );
    run({ ...process.env, npm_execpath: npm, GATE_LOG: log }, () =>
      readFileSync(log, 'utf8').trim().split('\n'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
test('complete gate executes every mandatory check with one unit coverage run', () =>
  fixture((env, log) => {
    const result = spawnSync(process.execPath, [runner], { env });
    assert.equal(result.status, 0, result.stderr?.toString());
    assert.deepEqual(log(), mandatory);
  }));
test('a failed stage preserves its exit status and stops subsequent stages', () =>
  fixture((env, log) => {
    const result = spawnSync(process.execPath, [runner], { env: { ...env, GATE_FAIL: 'build' } });
    assert.equal(result.status, 37);
    assert.deepEqual(log(), mandatory.slice(0, 3));
  }));
test('a cancelled process cannot pass the gate', () =>
  fixture((env, log) => {
    const result = spawnSync(process.execPath, [runner], { env: { ...env, GATE_CANCEL: 'lint' } });
    assert.notEqual(result.status, 0);
    assert.deepEqual(log(), mandatory.slice(0, 2));
  }));
test('fast feedback runs units instead of coverage and excludes inference', () =>
  fixture((env, log) => {
    const result = spawnSync(process.execPath, [runner, '--task'], { env });
    assert.equal(result.status, 0);
    assert.deepEqual(log(), [...mandatory.slice(0, 6), 'test']);
  }));
test('CI profiles together retain the complete gate', () =>
  fixture((env, log) => {
    assert.equal(spawnSync(process.execPath, [runner, '--ci'], { env }).status, 0);
    assert.equal(spawnSync(process.execPath, [runner, '--quality'], { env }).status, 0);
    assert.deepEqual(log(), mandatory);
  }));
test('aggregator rejects every failed, cancelled, skipped or missing mandatory job', () => {
  const call = (needs) =>
    spawnSync(process.execPath, [aggregator], {
      env: { ...process.env, CI_NEEDS: JSON.stringify(needs) },
    }).status;
  assert.equal(call({ test: { result: 'success' }, quality: { result: 'success' } }), 0);
  for (const job of ['test', 'quality']) {
    for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
      assert.notEqual(
        call({ test: { result: 'success' }, quality: { result: 'success' }, [job]: { result } }),
        0,
      );
    }
  }
  assert.notEqual(call({}), 0);
});

test('documentation-only changes still run the complete gate freshly on every invocation', () =>
  fixture((env, log) => {
    const changed = { ...env, OHS_PRE_PUSH_CHANGED_FILES: 'README.md' };
    assert.equal(spawnSync(process.execPath, [runner], { env: changed }).status, 0);
    assert.equal(spawnSync(process.execPath, [runner], { env: changed }).status, 0);
    assert.deepEqual(log(), [...mandatory, ...mandatory]);
  }));
