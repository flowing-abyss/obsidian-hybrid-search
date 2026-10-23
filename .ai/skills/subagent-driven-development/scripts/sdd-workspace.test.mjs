import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sdd-workspace.mjs');

let repo;
let outside;

before(() => {
  repo = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'sdd-workspace-repo-')));
  outside = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'sdd-workspace-outside-')));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  for (const plan of [
    'docs/alpha/plan.md',
    'docs/beta/plan.md',
    'other/alpha/plan.md',
    'third/alpha/plan.md',
    'docs/legacy.md',
  ]) {
    mkdirSync(path.dirname(path.join(repo, plan)), { recursive: true });
    writeFileSync(path.join(repo, plan), `# ${plan}\n`);
  }
  writeFileSync(path.join(outside, 'plan.md'), '# outside\n');
});

after(() => {
  rmSync(repo, { force: true, recursive: true });
  rmSync(outside, { force: true, recursive: true });
});

function workspace(planFile, cwd = repo) {
  return execFileSync(process.execPath, [scriptPath, planFile], { cwd, encoding: 'utf8' }).trim();
}

const marker = (dir) => readFileSync(path.join(dir, 'plan-path'), 'utf8');

test('a plan gets its basename workspace, marked with its repo-relative path', () => {
  const dir = workspace('docs/alpha/plan.md');
  assert.equal(dir, path.join(repo, '.superpowers', 'sdd', 'plan'));
  assert.equal(marker(dir), 'docs/alpha/plan.md\n');
  assert.equal(readFileSync(path.join(repo, '.superpowers', 'sdd', '.gitignore'), 'utf8'), '*\n');
});

test('relative, absolute, and ../ spellings of one plan resolve to the same workspace', () => {
  const expected = workspace('docs/alpha/plan.md');
  assert.equal(workspace(path.join(repo, 'docs', 'alpha', 'plan.md')), expected);
  assert.equal(workspace('../alpha/plan.md', path.join(repo, 'docs', 'beta')), expected);
});

test('a second plan with the same basename gets its parent-directory slug', () => {
  const alpha = workspace('docs/alpha/plan.md');
  const beta = workspace('docs/beta/plan.md');
  assert.notEqual(beta, alpha);
  assert.equal(beta, path.join(repo, '.superpowers', 'sdd', 'plan-beta'));
  assert.equal(marker(beta), 'docs/beta/plan.md\n');
});

test('plans whose parent directory names also collide get a counter', () => {
  workspace('docs/alpha/plan.md');
  const other = workspace('other/alpha/plan.md');
  const third = workspace('third/alpha/plan.md');
  assert.equal(other, path.join(repo, '.superpowers', 'sdd', 'plan-alpha'));
  assert.equal(third, path.join(repo, '.superpowers', 'sdd', 'plan-alpha-2'));
  assert.equal(marker(third), 'third/alpha/plan.md\n');
  assert.equal(workspace('third/alpha/plan.md'), third);
});

test('a plan outside the repo is marked with its absolute path', () => {
  const dir = workspace(path.join(outside, 'plan.md'));
  assert.equal(marker(dir), `${path.join(outside, 'plan.md')}\n`);
  assert.ok(dir.startsWith(path.join(repo, '.superpowers', 'sdd', 'plan-')));
});

test('a legacy workspace without a marker is adopted by the plan that resolves to it', () => {
  const legacy = path.join(repo, '.superpowers', 'sdd', 'legacy');
  mkdirSync(legacy, { recursive: true });
  writeFileSync(path.join(legacy, 'progress.md'), '# SDD ledger — plan: docs/legacy.md\n');
  assert.equal(workspace('docs/legacy.md'), legacy);
  assert.equal(marker(legacy), 'docs/legacy.md\n');
  assert.ok(existsSync(path.join(legacy, 'progress.md')));
});

test('a missing plan file exits 2', () => {
  assert.throws(
    () => workspace('docs/missing.md'),
    (error) => error.status === 2,
  );
});

test('keeps an existing workspace ignore policy byte-for-byte', () => {
  workspace('docs/alpha/plan.md');
  const ignore = path.join(repo, '.superpowers', 'sdd', '.gitignore');
  const policy = '*\n!progress.md\n';
  writeFileSync(ignore, policy);
  workspace('docs/beta/plan.md');
  assert.equal(readFileSync(ignore, 'utf8'), policy);
});
