import assert from 'node:assert/strict';
import fs, { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { afterEach, describe, it, vi } from 'vitest';
import { resolveGitContext } from '../src/vault/git-context.js';
import { createIgnorePolicy } from '../src/vault/ignore.js';
import { createGitFixture } from './helpers/git-fixture.js';

let fixture: ReturnType<typeof createGitFixture> | undefined;

function preserveLegacyAliasSpelling() {
  // Node's non-native Windows resolver preserves 8.3 aliases. Use a real
  // directory alias on every platform to exercise the same boundary.
  const native = fs.realpathSync.native;
  const legacy = vi
    .spyOn(fs, 'realpathSync')
    .mockImplementation((file) => path.resolve(String(file)));
  Object.assign(legacy, { native });
  syncBuiltinESMExports();
}

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  fixture?.dispose();
  fixture = undefined;
});

describe('containing Git repository context', () => {
  it('includes the root Gitignore when a repository occupies the filesystem root', () => {
    fixture = createGitFixture();
    const root = path.parse(fixture.root).root;
    const vault = path.join(root, 'projects', 'notes');
    const directoryStats = fs.statSync(fixture.repo);
    vi.spyOn(fs, 'statSync').mockImplementation((file) => {
      if (String(file) === vault || String(file) === path.join(root, '.git')) return directoryStats;
      throw Object.assign(new Error('missing fixture path'), { code: 'ENOENT' });
    });
    vi.spyOn(fs.realpathSync, 'native').mockImplementation((file) => String(file));
    syncBuiltinESMExports();
    assert.deepEqual(resolveGitContext(vault)?.ancestorGitignorePaths, [
      path.join(root, '.gitignore'),
      path.join(root, 'projects', '.gitignore'),
    ]);
  });
  for (const linked of [false, true]) {
    for (const vaultPrefix of ['', 'projects/notes']) {
      it(
        'matches Git layout for ' + (linked ? 'linked' : 'regular') + ' vault ' + vaultPrefix,
        () => {
          fixture = createGitFixture({ linked, vaultPrefix });
          const context = resolveGitContext(fixture.vault);
          assert.ok(context);
          assert.equal(
            context.worktreePath,
            fs.realpathSync.native(fixture.git(['rev-parse', '--show-toplevel'])),
          );
          assert.equal(
            context.gitDirPath,
            fs.realpathSync.native(fixture.git(['rev-parse', '--absolute-git-dir'])),
          );
          assert.equal(context.commonDirPath, fixture.commonDir);
          assert.equal(context.excludePath, fixture.exclude);
          assert.equal(context.vaultPrefix, vaultPrefix);
          assert.deepEqual(
            context.ancestorGitignorePaths,
            vaultPrefix
              ? [
                  path.join(fixture.repo, '.gitignore'),
                  path.join(fixture.repo, 'projects/.gitignore'),
                ]
              : [],
          );
          assert.ok(context.indirectionFiles.includes(path.join(context.gitDirPath, 'commondir')));
          if (linked) assert.ok(context.indirectionFiles.includes(path.join(fixture.repo, '.git')));
        },
      );
    }
  }
  it('keeps the exclude target even before its info directory exists', () => {
    fixture = createGitFixture();
    rmSync(path.dirname(fixture.exclude), { recursive: true });
    assert.equal(resolveGitContext(fixture.vault)?.excludePath, fixture.exclude);
  });
  it('does not treat a standalone vault as a Git repository', () => {
    fixture = createGitFixture();
    const outside = path.join(fixture.root, 'outside');
    mkdirSync(outside);
    assert.equal(resolveGitContext(outside), undefined);
  });
  it('resolves a relative gitfile against its own directory', () => {
    fixture = createGitFixture();
    const separate = path.join(fixture.root, 'separate metadata');
    fixture.git(['init', '--quiet', '--separate-git-dir', separate]);
    fixture.write('.git', 'gitdir: ' + path.relative(fixture.repo, separate) + '\r\n');
    assert.equal(resolveGitContext(fixture.vault)?.gitDirPath, separate);
  });
  it('resolves a vault symlink to the physical containing repository', () => {
    fixture = createGitFixture({ vaultPrefix: 'projects/notes' });
    const alias = path.join(fixture.root, 'vault alias');
    symlinkSync(fixture.vault, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(resolveGitContext(alias)?.vaultPrefix, 'projects/notes');
    assert.equal(resolveGitContext(alias)?.excludePath, fixture.exclude);
  });
  it('keeps repository coordinates independent of a legacy physical-path alias', () => {
    fixture = createGitFixture({ vaultPrefix: 'projects/notes' });
    const expected = resolveGitContext(fixture.vault);
    const alias = path.join(fixture.root, 'repository alias');
    symlinkSync(fixture.repo, alias, process.platform === 'win32' ? 'junction' : 'dir');
    preserveLegacyAliasSpelling();
    assert.deepEqual(resolveGitContext(path.join(alias, 'projects/notes')), expected);
  });
  for (const pointerKind of ['gitdir', 'commondir']) {
    it('keeps rules, signature and watch targets stable across a ' + pointerKind + ' alias', () => {
      fixture = createGitFixture({ linked: true, vaultPrefix: 'projects/notes' });
      fixture.write('projects/notes/Café/note.md', '# Note');
      writeFileSync(fixture.exclude, '/projects/notes/Café/note.md\n');
      const policy = () =>
        createIgnorePolicy({
          vaultPath: fixture!.vault,
          ignorePatterns: [],
          includePatterns: [],
          respectGitignore: true,
        });
      const before = policy();
      const context = resolveGitContext(fixture.vault)!;
      const alias = path.join(fixture.root, 'Café metadata alias');
      const target = pointerKind === 'gitdir' ? context.gitDirPath : context.commonDirPath;
      symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
      if (pointerKind === 'gitdir') {
        fixture.write('.git', 'gitdir: ' + path.relative(fixture.repo, alias) + '\n');
      } else {
        writeFileSync(
          path.join(context.gitDirPath, 'commondir'),
          path.relative(context.gitDirPath, alias) + '\n',
        );
      }
      assert.equal(fixture.ignored('Café/note.md'), true);
      preserveLegacyAliasSpelling();
      const after = policy();
      assert.equal(after.isIgnored('Café/note.md'), true);
      assert.deepEqual(resolveGitContext(fixture.vault), context);
      assert.deepEqual(after.controlWatchFiles, before.controlWatchFiles);
      assert.equal(after.signature(), before.signature());
    });
  }
  for (const content of ['', 'not a gitfile\n', 'gitdir: \n', 'gitdir: \0bad\n']) {
    it('reports malformed gitfiles with their source path ' + JSON.stringify(content), () => {
      fixture = createGitFixture({ linked: true });
      const gitfile = path.join(fixture.repo, '.git');
      fixture.write('.git', content);
      assert.throws(
        () => resolveGitContext(fixture!.vault),
        (error: unknown) => error instanceof Error && error.message.includes(gitfile),
      );
    });
  }
  it('reports a malformed or non-file commondir without falling back to another repository', () => {
    fixture = createGitFixture({ linked: true });
    const context = resolveGitContext(fixture.vault)!;
    const pointer = path.join(context.gitDirPath, 'commondir');
    const original = readFileSync(pointer, 'utf8');
    assert.match(original, /\.\./);
    writeFileSync(pointer, '\n');
    assert.throws(() => resolveGitContext(fixture!.vault), /commondir/);
    rmSync(pointer);
    mkdirSync(pointer);
    assert.throws(() => resolveGitContext(fixture!.vault), /commondir/);
  });
});
