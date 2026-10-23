import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'review-package.mjs');

let repo;
let base;
let head;
let sideBranch;
let largeHead;
const largeContent =
  'Complete diff content '.repeat(64).concat('\n').repeat(1024) + 'TRAILING-LARGE-DIFF-SENTINEL\n';

before(() => {
  repo = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'review-package-')));
  const git = (...args) =>
    execFileSync(
      // This fixture invokes Git or a fixed test executable on the developer PATH, without interpolating shell input.
      // eslint-disable-next-line sonarjs/no-os-command-from-path
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
  writeFileSync(path.join(repo, 'plan.md'), '# plan\n');
  git('add', 'plan.md');
  git('commit', '-q', '-m', 'base');
  base = git('rev-parse', 'HEAD');
  git('switch', '-q', '-c', 'side');
  writeFileSync(path.join(repo, 'side.txt'), 'side\n');
  git('add', 'side.txt');
  git('commit', '-q', '-m', 'side work');
  sideBranch = git('rev-parse', 'HEAD');
  git('switch', '-q', '-');
  writeFileSync(path.join(repo, 'feature.txt'), 'feature\n');
  git('add', 'feature.txt');
  git('commit', '-q', '-m', 'feature work');
  head = git('rev-parse', 'HEAD');
  writeFileSync(path.join(repo, 'large.txt'), largeContent);
  git('add', 'large.txt');
  git('commit', '-q', '-m', 'large diff');
  largeHead = git('rev-parse', 'HEAD');
});

after(() => rmSync(repo, { force: true, recursive: true }));

const run = (...args) =>
  spawnSync(process.execPath, [scriptPath, 'plan.md', ...args], { cwd: repo, encoding: 'utf8' });

test('writes the commits, stat, and diff of BASE..HEAD to the plan workspace', () => {
  const result = run(base, head);
  assert.equal(result.status, 0, result.stderr);
  const out = result.stdout.match(/^wrote (.+): 1 commit\(s\)/)?.[1];
  assert.ok(out, result.stdout);
  const content = readFileSync(out, 'utf8');
  assert.match(content, /feature work/);
  assert.match(content, /\+feature/);
  assert.doesNotMatch(content, /side work/);
});

test('an empty range exits 3 without writing a package', () => {
  const out = path.join(repo, 'empty.diff');
  const result = run(head, head, out);
  assert.equal(result.status, 3);
  assert.match(result.stderr, /empty commit range/);
  assert.equal(existsSync(out), false);
});

test('a HEAD that does not descend from BASE exits 3 without writing a package', () => {
  const out = path.join(repo, 'unrooted.diff');
  const result = run(sideBranch, head, out);
  assert.equal(result.status, 3);
  assert.match(result.stderr, /not a descendant of BASE/);
  assert.equal(existsSync(out), false);
});

test('an unknown revision exits 2', () => {
  const result = run('no-such-revision', head);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /bad BASE/);
});

test('writes a complete diff larger than 1 MiB including its trailing content', () => {
  const out = path.join(repo, 'large.diff');
  const result = run(head, largeHead, out);
  assert.equal(result.status, 0, result.stderr);
  const content = readFileSync(out, 'utf8');
  assert.ok(Buffer.byteLength(content) > 1024 * 1024);
  const addedLines = content
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1));
  assert.equal(addedLines.join('\n') + '\n', largeContent);
  assert.ok(content.endsWith('+TRAILING-LARGE-DIFF-SENTINEL\n'));
});

test('a failed Git diff preserves the existing output and removes partial temporary output', () => {
  const outputDir = mkdtempSync(path.join(repo, 'failed-package-'));
  const out = path.join(outputDir, 'existing.diff');
  writeFileSync(out, 'Previous complete review package\n');
  const result = spawnSync(process.execPath, [scriptPath, 'plan.md', base, head, out], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, GIT_EXTERNAL_DIFF: path.join(repo, 'missing-diff-program') },
  });
  assert.equal(result.status, 128);
  assert.match(result.stderr, /external diff|cannot run/);
  assert.equal(readFileSync(out, 'utf8'), 'Previous complete review package\n');
  assert.deepEqual(readdirSync(outputDir), ['existing.diff']);
});
