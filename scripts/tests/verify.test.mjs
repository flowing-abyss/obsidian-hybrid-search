import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { verificationEnv } from '../run-command.mjs';

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

test('Git hook variables cannot redirect fixture operations into the invoking repository', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ohs-gate-git-env-'));
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')),
  );
  try {
    const parent = path.join(root, 'parent');
    const child = path.join(root, 'fixture');
    mkdirSync(parent);
    mkdirSync(child);
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- The fixture invokes the required Git executable with fixed arguments and a clean environment.
    const init = spawnSync('git', ['init', '--quiet'], {
      cwd: parent,
      env: cleanEnv,
      encoding: 'utf8',
    });
    assert.equal(init.status, 0, init.stderr);
    const parentGit = path.join(parent, '.git');
    const configPath = path.join(parentGit, 'config');
    const before = readFileSync(configPath, 'utf8');
    const npm = path.join(root, 'npm.cjs');
    writeFileSync(
      npm,
      `
      if (process.argv[3] === 'test:ai') {
        const {spawnSync} = require('node:child_process');
        const result = spawnSync('git', ['init', '--quiet'], {cwd: process.env.GATE_FIXTURE, stdio: 'inherit'});
        process.exitCode = result.status ?? 1;
      }
    `,
    );
    const env = {
      ...cleanEnv,
      npm_execpath: npm,
      GATE_FIXTURE: child,
      GIT_DIR: parentGit,
      GIT_COMMON_DIR: parentGit,
      GIT_WORK_TREE: parent,
      GIT_IMPLICIT_WORK_TREE: '0',
      GIT_PREFIX: '',
    };
    const mixedCase = {
      ...env,
      Git_Dir: parentGit,
      git_common_dir: parentGit,
      Git_Config_Count: '0',
      Git_Config_Key_0: 'core.abbrev',
      Git_Config_Value_0: '7',
      GIT_TERMINAL_PROMPT: '0',
    };
    const isolated = verificationEnv(mixedCase);
    for (const name of [
      'Git_Dir',
      'git_common_dir',
      'Git_Config_Count',
      'Git_Config_Key_0',
      'Git_Config_Value_0',
    ]) {
      assert.equal(
        isolated[name],
        undefined,
        `${name} must not survive with Windows environment semantics`,
      );
    }
    assert.equal(isolated.GIT_TERMINAL_PROMPT, '0', 'nonlocal Git settings must survive');
    assert.equal(mixedCase.Git_Dir, parentGit, 'source environment must remain unchanged');
    const result = spawnSync(process.execPath, [runner, '--task'], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(path.join(child, '.git')), 'fixture must get its own Git repository');
    assert.equal(
      readFileSync(configPath, 'utf8'),
      before,
      'invoking repository config must stay untouched',
    );
    assert.equal(env.GIT_DIR, parentGit, 'the caller environment must stay unchanged');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verification stops before fixtures when Git environment discovery is unavailable', () =>
  fixture((env, log) => {
    const withoutPath = Object.fromEntries(
      Object.entries(env).filter(([key]) => key.toUpperCase() !== 'PATH'),
    );
    const result = spawnSync(process.execPath, [runner, '--task'], {
      env: { ...withoutPath, PATH: '' },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /git|ENOENT/);
    assert.throws(log, { code: 'ENOENT' });
  }));
