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

const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'review-package.mjs');

let repo;
let base;
let head;
let sideBranch;

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
