import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mainPackage, nativePackage } from './codegraph-fixture.mjs';
const ai = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'ohs-ai-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, '.ai/configs/.codex'), { recursive: true });
  mkdirSync(path.join(root, '.ai/skills/example'), { recursive: true });
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ devDependencies: { '@colbymchenry/codegraph': '1.6.2' } }),
  );
  writeFileSync(path.join(root, '.ai/configs/AGENTS.md'), 'canonical instructions\n');
  writeFileSync(path.join(root, '.ai/configs/.codex/config.toml'), '# local index\n');
  for (const name of ['setup.mjs', 'setup-codegraph.mjs', 'codegraph.mjs']) {
    if (existsSync(path.join(ai, name))) cpSync(path.join(ai, name), path.join(root, '.ai', name));
  }
  mkdirSync(path.join(root, '.ai/scripts/opencode'), { recursive: true });
  mkdirSync(path.join(root, '.ai/scripts/pi'), { recursive: true });
  writeFileSync(path.join(root, '.ai/scripts/codegraph-prompt.mjs'), '// helper');
  writeFileSync(path.join(root, '.ai/scripts/opencode/codegraph.js'), '// adapter');
  writeFileSync(path.join(root, '.ai/scripts/pi/codegraph.ts'), '// adapter');
  return root;
}
const run = (root, script = 'setup.mjs', args = [], env = {}) =>
  spawnSync(process.execPath, [path.join(root, '.ai', script), ...args], {
    cwd: tmpdir(),
    encoding: 'utf8',
    env: { ...process.env, CI: '', ...env },
    timeout: 10000,
  });
test('clean checkout creates relative canonical links and repeated setup keeps them', (t) => {
  const root = fixture(t);
  const first = run(root);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), 'canonical instructions\n');
  assert.equal(readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), 'canonical instructions\n');
  if (process.platform !== 'win32')
    assert.equal(readlinkSync(path.join(root, 'AGENTS.md')), '.ai/configs/AGENTS.md');
  const before = lstatSync(path.join(root, 'AGENTS.md')).ino;
  assert.equal(run(root).status, 0);
  assert.equal(lstatSync(path.join(root, 'AGENTS.md')).ino, before);
});
test('unrelated files and directories remain conflicts without losing their contents', (t) => {
  const root = fixture(t);
  writeFileSync(path.join(root, 'AGENTS.md'), 'my instructions');
  mkdirSync(path.join(root, '.agents/skills'), { recursive: true });
  writeFileSync(path.join(root, '.agents/skills/custom'), 'mine');
  assert.equal(run(root).status, 1);
  assert.equal(readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), 'my instructions');
  assert.equal(readFileSync(path.join(root, '.agents/skills/custom'), 'utf8'), 'mine');
});
test('moved checkout and nested worktree resolve their own canonical sources', (t) => {
  const parent = fixture(t);
  assert.equal(run(parent).status, 0);
  const nested = path.join(parent, '.worktrees/task');
  mkdirSync(path.dirname(nested), { recursive: true });
  const donor = fixture(t);
  cpSync(donor, nested, { recursive: true });
  writeFileSync(path.join(nested, '.ai/configs/AGENTS.md'), 'worktree instructions');
  assert.equal(run(nested).status, 0);
  const moved = `${parent}-moved`;
  renameSync(parent, moved);
  t.after(() => rmSync(moved, { recursive: true, force: true }));
  const movedNested = path.join(moved, '.worktrees/task');
  assert.equal(run(movedNested).status, 0);
  assert.equal(readFileSync(path.join(movedNested, 'AGENTS.md'), 'utf8'), 'worktree instructions');
});
test('linked parent outside checkout is rejected without writing external configuration', (t) => {
  if (process.platform === 'win32') return t.skip('POSIX symlink fixture');
  const root = fixture(t),
    outside = fixture(t);
  symlinkSync(outside, path.join(root, '.codex'));
  assert.equal(run(root).status, 1);
  assert.equal(existsSync(path.join(outside, 'config.toml')), false);
});
test('Windows managed hardlinks refresh after atomic source replacement and preserve custom replacements', async (t) => {
  const root = fixture(t);
  assert.ok(existsSync(path.join(root, '.ai/setup.mjs')), 'setup implementation must exist');
  const { setup } = await import(pathToFileURL(path.join(root, '.ai/setup.mjs')).href);
  assert.equal(setup(root, { platform: 'win32', log: () => {} }), 0);
  const canonical = path.join(root, '.ai/configs/AGENTS.md');
  writeFileSync(`${canonical}.tmp`, 'new canonical');
  renameSync(`${canonical}.tmp`, canonical);
  assert.equal(setup(root, { platform: 'win32', log: () => {} }), 0);
  assert.equal(statSync(path.join(root, 'AGENTS.md')).ino, statSync(canonical).ino);
  assert.equal(readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), 'new canonical');
  rmSync(path.join(root, 'AGENTS.md'));
  writeFileSync(path.join(root, 'AGENTS.md'), 'custom');
  assert.equal(setup(root, { platform: 'win32', log: () => {} }), 1);
  assert.equal(readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), 'custom');
});
test('CodeGraph without dev dependencies is best effort; explicit CLI reports missing local package', (t) => {
  const root = fixture(t);
  const setup = run(root, 'setup-codegraph.mjs');
  assert.equal(setup.status, 0, setup.stderr);
  assert.match(setup.stderr, /codegraph/i);
  assert.equal(run(root, 'codegraph.mjs', ['status']).status, 1);
  assert.equal(run(root, 'codegraph.mjs', ['prompt-hook']).status, 0);
  assert.equal(existsSync(path.join(root, 'node_modules')), false);
});
test('Windows stale managed files that users edited remain conflicts', async (t) => {
  const root = fixture(t);
  const { setup } = await import(pathToFileURL(path.join(root, '.ai/setup.mjs')).href);
  assert.equal(setup(root, { platform: 'win32', log: () => {} }), 0);
  const canonical = path.join(root, '.ai/configs/AGENTS.md');
  writeFileSync(`${canonical}.tmp`, 'next canonical');
  renameSync(`${canonical}.tmp`, canonical);
  writeFileSync(path.join(root, 'AGENTS.md'), 'local edit after replacement');
  assert.equal(setup(root, { platform: 'win32', log: () => {} }), 1);
  assert.equal(readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), 'local edit after replacement');
});
test('Windows moved junctions rebase only generated links', async (t) => {
  const root = fixture(t);
  const { setup } = await import(pathToFileURL(path.join(root, '.ai/setup.mjs')).href);
  assert.equal(setup(root, { platform: 'win32', log: () => {} }), 0);
  const moved = `${root}-moved`;
  renameSync(root, moved);
  t.after(() => rmSync(moved, { recursive: true, force: true }));
  assert.equal(setup(moved, { platform: 'win32', log: () => {} }), 0);
  assert.equal(
    statSync(path.join(moved, '.agents/skills')).ino,
    statSync(path.join(moved, '.ai/skills')).ino,
  );
});
test('CodeGraph launcher never borrows an ancestor checkout dependency', (t) => {
  const parent = fixture(t);
  const packageDir = path.join(parent, 'node_modules/@colbymchenry/codegraph');
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    path.join(packageDir, 'package.json'),
    JSON.stringify({ version: '1.6.2', bin: { codegraph: 'bin.cjs' } }),
  );
  writeFileSync(path.join(packageDir, 'bin.cjs'), "console.log('PARENT GRAPH');");
  const root = path.join(parent, '.worktrees/task');
  cpSync(fixture(t), root, { recursive: true });
  const result = run(root, 'codegraph.mjs', ['status']);
  assert.equal(result.status, 1, result.stdout);
  assert.doesNotMatch(result.stdout, /PARENT GRAPH/);
});
test('prepare configures a checkout with no developer dependencies', (t) => {
  const root = fixture(t);
  cpSync(path.join(ai, 'prepare.mjs'), path.join(root, '.ai/prepare.mjs'));
  assert.equal(run(root, 'prepare.mjs', [], { CI: '1' }).status, 0);
  assert.equal(readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), 'canonical instructions\n');
  assert.equal(existsSync(path.join(root, 'node_modules')), false);
});
test('CodeGraph remains local with telemetry and download recovery disabled', (t) => {
  const root = fixture(t);
  mainPackage(root);
  nativePackage(
    root,
    'console.log(JSON.stringify({telemetry:process.env.CODEGRAPH_TELEMETRY,download:process.env.CODEGRAPH_NO_DOWNLOAD}));',
  );
  const result = run(root, 'codegraph.mjs', ['status'], {
    CODEGRAPH_TELEMETRY: '',
    CODEGRAPH_NO_DOWNLOAD: '',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { telemetry: '0', download: '1' });
});
test('prepare invokes the local Husky binary when dev dependencies are installed', (t) => {
  const root = fixture(t),
    husky = path.join(root, 'node_modules/husky');
  mkdirSync(husky, { recursive: true });
  writeFileSync(path.join(husky, 'package.json'), JSON.stringify({ main: 'index.js' }));
  writeFileSync(path.join(husky, 'index.js'), '');
  writeFileSync(
    path.join(husky, 'bin.js'),
    "require('node:fs').writeFileSync('.husky-installed','yes');",
  );
  cpSync(path.join(ai, 'prepare.mjs'), path.join(root, '.ai/prepare.mjs'));
  assert.equal(run(root, 'prepare.mjs', [], { CI: '1' }).status, 0);
  assert.equal(existsSync(path.join(root, '.husky-installed')), true);
});
test('setup preserves an unrelated file occupying its temporary link name', async (t) => {
  const root = fixture(t);
  const temporary = path.join(root, `AGENTS.md.ai-setup-${process.pid}`);
  writeFileSync(temporary, 'custom temporary file');
  const { setup } = await import(pathToFileURL(path.join(root, '.ai/setup.mjs')).href);
  assert.equal(setup(root, { log: () => {} }), 1);
  assert.equal(readFileSync(temporary, 'utf8'), 'custom temporary file');
});
test('gitignore keeps canonical configs trackable and generated links local', (t) => {
  const root = fixture(t);
  cpSync(path.join(ai, '../.gitignore'), path.join(root, '.gitignore'));
  const init = spawnSync('git', ['init', '--quiet'], { cwd: root, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const ignored = (relative) =>
    spawnSync('git', ['check-ignore', '--no-index', '--quiet', relative], { cwd: root }).status;
  assert.equal(ignored('.ai/configs/AGENTS.md'), 1);
  assert.equal(ignored('.ai/configs/.codex/config.toml'), 1);
  assert.equal(ignored('AGENTS.md'), 0);
  assert.equal(ignored('CLAUDE.md'), 0);
  assert.equal(ignored('.codex/config.toml'), 0);
  assert.equal(ignored('.ai/.setup-state.json'), 0);
});
