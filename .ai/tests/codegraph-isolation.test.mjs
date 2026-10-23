import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  aiRoot,
  checkout,
  index,
  mainPackage,
  nativePackage,
  platformName,
} from './codegraph-fixture.mjs';
const run = (root, args = ['--version'], payload, env = {}) =>
  spawnSync(process.execPath, [path.join(root, '.ai/codegraph.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
    input: payload === undefined ? undefined : JSON.stringify(payload),
    env: { ...process.env, CODEGRAPH_NO_DOWNLOAD: '1', ...env },
    timeout: 5000,
  });
function nested(t, parent) {
  const donor = checkout(t),
    root = path.join(parent, '.worktrees/task');
  mkdirSync(path.dirname(root), { recursive: true });
  cpSync(donor, root, { recursive: true });
  mainPackage(root);
  return root;
}
test('actual npm shim cannot select an ancestor platform package', (t) => {
  const parent = checkout(t);
  nativePackage(parent, "console.log('ANCESTOR PLATFORM0.0.1');", '0.0.1');
  const root = nested(t, parent),
    result = run(root);
  assert.equal(result.status, 1, result.stdout);
  assert.equal(result.stdout, '');
});
test('actual npm shim cannot use a preexisting global bundle cache', (t) => {
  const root = checkout(t);
  mainPackage(root);
  const cache = path.join(root, 'cache'),
    bundle = path.join(cache, 'bundles', `${process.platform}-${process.arch}-1.6.2`);
  nativePackage(root, "console.log('GLOBAL CACHE');", '1.6.2', bundle);
  const result = run(root, ['--version'], undefined, { CODEGRAPH_INSTALL_DIR: cache });
  assert.equal(result.status, 1, result.stdout);
  assert.equal(result.stdout, '');
});
for (const version of ['0.0.1', '1.6.3'])
  test(`local native bundle ${version} cannot override lockfile pin`, (t) => {
    const root = checkout(t);
    mainPackage(root);
    nativePackage(root, "console.log('WRONG VERSION');", version);
    const result = run(root);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(result.stdout, '');
  });
test('matching exact local native bundle executes directly without the main shim', (t) => {
  const root = checkout(t);
  mainPackage(root);
  nativePackage(root);
  writeFileSync(
    path.join(root, 'node_modules/@colbymchenry/codegraph/npm-shim.js'),
    "throw new Error('shim must not run');",
  );
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /LOCAL PLATFORM1.6.2/);
});
const selectionScript = `const fs=require('node:fs'); const input=JSON.parse(fs.readFileSync(0,'utf8'));const {planFrontload}=require(${JSON.stringify(path.join(aiRoot, '../node_modules', platformName, 'lib/dist/directory.js'))}); const plan=planFrontload(input.cwd,input.prompt); if(plan.exploreRoot) console.log(JSON.stringify({root:plan.exploreRoot,cwd:input.cwd,codegraphDir:process.env.CODEGRAPH_DIR}));`;
test('nested checkout with no local index injects no ancestor source', (t) => {
  const parent = checkout(t);
  index(parent);
  const root = nested(t, parent);
  nativePackage(root, selectionScript);
  const result = run(root, ['prompt-hook'], {
    prompt: 'How does search architecture work?',
    cwd: root,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});
for (const kind of ['empty', 'foreign', 'linked'])
  test(`unusable ${kind} local index injects no ancestor source`, (t) => {
    const parent = checkout(t);
    index(parent);
    const root = nested(t, parent);
    nativePackage(root, selectionScript);
    if (kind === 'linked')
      symlinkSync(
        path.join(parent, '.codegraph'),
        path.join(root, '.codegraph'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    else {
      mkdirSync(path.join(root, '.codegraph'));
      writeFileSync(
        path.join(root, '.codegraph/codegraph.db'),
        kind === 'empty' ? '' : 'not a database',
      );
    }
    const result = run(root, ['prompt-hook'], {
      prompt: 'How does search architecture work?',
      cwd: root,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  });
test('prompt payload cannot redirect local context to an ancestor checkout', (t) => {
  const parent = checkout(t);
  index(parent);
  const root = nested(t, parent);
  nativePackage(root, selectionScript);
  index(root);
  const result = run(root, ['prompt-hook'], {
    prompt: 'How does search architecture work?',
    cwd: parent,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});
test('valid local subdirectory payload is pinned to checkout root despite ambient index override', (t) => {
  const root = checkout(t);
  mainPackage(root);
  nativePackage(root, selectionScript);
  index(root);
  mkdirSync(path.join(root, 'src'));
  const result = run(
    root,
    ['prompt-hook'],
    { prompt: 'How does search architecture work?', cwd: path.join(root, 'src') },
    { CODEGRAPH_DIR: 'other-index' },
  );
  assert.equal(result.status, 0, result.stderr);
  const context = JSON.parse(result.stdout);
  assert.equal(context.root, realpathSync(root));
  assert.equal(context.cwd, realpathSync(root));
  assert.equal(context.codegraphDir, '.codegraph');
});
test('local main package version must match the exact checkout pin', (t) => {
  const root = checkout(t);
  mainPackage(root, '0.0.1');
  nativePackage(root);
  const result = run(root);
  assert.equal(result.status, 1, result.stdout);
  assert.equal(result.stdout, '');
});
test('a platform package symlink cannot substitute an ancestor bundle', (t) => {
  const parent = checkout(t);
  const ancestor = nativePackage(parent);
  const root = nested(t, parent);
  mkdirSync(path.join(root, 'node_modules/@colbymchenry'), { recursive: true });
  symlinkSync(
    ancestor,
    path.join(root, 'node_modules', platformName),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const result = run(root);
  assert.equal(result.status, 1, result.stdout);
  assert.equal(result.stdout, '');
});
test('a parent adapter refuses a nested checkout payload', (t) => {
  const root = checkout(t);
  mainPackage(root);
  nativePackage(root, selectionScript);
  index(root);
  const child = nested(t, root);
  const result = run(root, ['prompt-hook'], {
    prompt: 'How does the search architecture work?',
    cwd: child,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});
