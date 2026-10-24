import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'vitest';
import { resolveGitContext } from '../src/vault/git-context.js';
import { createGitFixture } from './helpers/git-fixture.js';

let fixture: ReturnType<typeof createGitFixture> | undefined;
afterEach(() => {
  fixture?.dispose();
  fixture = undefined;
});

describe('containing Git repository context', () => {
  for (const linked of [false, true]) {
    for (const vaultPrefix of ['', 'projects/notes']) {
      it(
        'matches Git layout for ' + (linked ? 'linked' : 'regular') + ' vault ' + vaultPrefix,
        () => {
          fixture = createGitFixture({ linked, vaultPrefix });
          const context = resolveGitContext(fixture.vault);
          assert.ok(context);
          assert.equal(context.worktreePath, fixture.git(['rev-parse', '--show-toplevel']));
          assert.equal(context.gitDirPath, fixture.git(['rev-parse', '--absolute-git-dir']));
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
    writeFileSync(
      path.join(fixture.repo, '.git'),
      'gitdir: ' + path.relative(fixture.repo, separate) + '\r\n',
    );
    assert.equal(resolveGitContext(fixture.vault)?.gitDirPath, separate);
  });
  it('resolves a vault symlink to the physical containing repository', () => {
    fixture = createGitFixture({ vaultPrefix: 'projects/notes' });
    const alias = path.join(fixture.root, 'vault alias');
    symlinkSync(fixture.vault, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(resolveGitContext(alias)?.vaultPrefix, 'projects/notes');
    assert.equal(resolveGitContext(alias)?.excludePath, fixture.exclude);
  });
  for (const content of ['', 'not a gitfile\n', 'gitdir: \n', 'gitdir: \0bad\n']) {
    it('reports malformed gitfiles with their source path ' + JSON.stringify(content), () => {
      fixture = createGitFixture({ linked: true });
      const gitfile = path.join(fixture.repo, '.git');
      writeFileSync(gitfile, content);
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
