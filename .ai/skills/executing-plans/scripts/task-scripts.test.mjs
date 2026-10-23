import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
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
import { renderCommand } from './task-done.mjs';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));

const PLAN = `# Fixture Plan

## Global Constraints

- Package manager: pnpm only

---

### Task 1: Greeter

- [ ] **Step 1: Write the failing test**

### Task 2: Farewell

- [ ] **Step 1: Do the thing**
`;

let repo;
let git;

before(() => {
  repo = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'task-scripts-')));
  git = (...args) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd: repo, encoding: 'utf8' },
    ).trim();
  git('init', '-q');
  writeFileSync(path.join(repo, 'plan.md'), PLAN);
  git('add', 'plan.md');
  git('commit', '-q', '-m', 'plan');
});

after(() => rmSync(repo, { force: true, recursive: true }));

const run = (script, ...args) =>
  spawnSync(process.execPath, [path.join(scriptsDir, script), ...args], {
    cwd: repo,
    encoding: 'utf8',
  });

const workspace = () => path.join(repo, '.superpowers', 'sdd', 'plan');

function commit(file) {
  writeFileSync(path.join(repo, file), `${file}\n`);
  git('add', file);
  git('commit', '-q', '-m', file);
  return git('rev-parse', 'HEAD');
}

test('task-start writes the brief to the plan workspace and prints it with BASE', () => {
  const result = run('task-start.mjs', 'plan.md', '1');
  assert.equal(result.status, 0, result.stderr);
  const briefPath = path.join(workspace(), 'task-1-brief.md');
  assert.equal(result.stdout, `brief: ${briefPath}\nbase: ${git('rev-parse', 'HEAD')}\n`);
  const brief = readFileSync(briefPath, 'utf8');
  assert.match(brief, /Global Constraints/);
  assert.match(brief, /Task 1: Greeter/);
  assert.doesNotMatch(brief, /Task 2/);
});

test('task-start exits 3 for a task the plan does not have', () => {
  const result = run('task-start.mjs', 'plan.md', '9');
  assert.equal(result.status, 3);
  assert.match(result.stderr, /task 9 not found/);
});

test('task-done records a passing task with its range, command, and last output line', () => {
  const base = git('rev-parse', 'HEAD');
  const head = commit('greeter.txt');
  const script = "console.log('ran'); console.log('3/3 pass')";
  const result = run('task-done.mjs', 'plan.md', '1', base, '--', process.execPath, '-e', script);

  assert.equal(result.status, 0, result.stderr);
  const line = `Task 1: complete (commits ${base.slice(0, 7)}..${head.slice(0, 7)}, tests: ${renderCommand([process.execPath, '-e', script])} → 3/3 pass)`;
  assert.equal(result.stdout, `ran\n3/3 pass\nledger: ${line}\n`);
  assert.equal(
    readFileSync(path.join(workspace(), 'progress.md'), 'utf8'),
    `# SDD ledger — plan: plan.md\n${line}\n`,
  );
  assert.equal(readFileSync(path.join(workspace(), 'task-1-tests.log'), 'utf8'), 'ran\n3/3 pass\n');
});

test('task-done records nothing for a failing task and exits with its status', () => {
  const ledger = path.join(workspace(), 'progress.md');
  const before = existsSync(ledger) ? readFileSync(ledger, 'utf8') : null;
  const base = git('rev-parse', 'HEAD');
  const result = run(
    'task-done.mjs',
    'plan.md',
    '2',
    base,
    '--',
    process.execPath,
    '-e',
    "console.error('1 failed'); process.exit(4)",
  );

  assert.equal(result.status, 4);
  assert.match(result.stdout, /1 failed/);
  assert.match(result.stderr, /Task 2 NOT recorded/);
  assert.equal(existsSync(ledger) ? readFileSync(ledger, 'utf8') : null, before);
});

test('task-done reports a command that cannot start as a failure', () => {
  const base = git('rev-parse', 'HEAD');
  const result = run('task-done.mjs', 'plan.md', '2', base, '--', 'no-such-test-command-xyz');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Task 2 NOT recorded/);
});

test('task-done rejects a missing -- separator or an unknown BASE with exit 2', () => {
  assert.equal(run('task-done.mjs', 'plan.md', '1', 'HEAD', 'pnpm', 'test').status, 2);
  const badBase = run('task-done.mjs', 'plan.md', '1', 'no-such-rev', '--', 'pnpm', 'test');
  assert.equal(badBase.status, 2);
  assert.match(badBase.stderr, /bad BASE/);
});

test('renderCommand quotes only the arguments that need it', () => {
  assert.equal(
    renderCommand(['pnpm', 'test', '--', 'src/a b.test.ts']),
    "pnpm test -- 'src/a b.test.ts'",
  );
  assert.equal(renderCommand(['pnpm', 'exec', 'vitest', 'run']), 'pnpm exec vitest run');
});

test('task-done records silent and whitespace-only passing commands', () => {
  const base = git('rev-parse', 'HEAD');
  for (const script of ['', "console.log('  '); console.log('')"]) {
    const result = run('task-done.mjs', 'plan.md', '2', base, '--', process.execPath, '-e', script);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /→ \(no output\)\)/);
    assert.match(readFileSync(path.join(workspace(), 'progress.md'), 'utf8'), /→ \(no output\)\)/);
  }
});

test('renderCommand shows an empty argument explicitly', () => {
  assert.equal(renderCommand(['node', '-e', '']), "node -e ''");
});
