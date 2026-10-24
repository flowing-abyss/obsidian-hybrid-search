import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'vitest';
import { createIgnorePolicy } from '../src/vault/ignore.js';
import { createGitFixture } from './helpers/git-fixture.js';

let fixture: ReturnType<typeof createGitFixture> | undefined;
afterEach(() => {
  fixture?.dispose();
  fixture = undefined;
});
const prefix = 'projects/notes';
const cases = [
  { name: 'repository-root anchoring', exclude: '/cache/\n' },
  { name: 'nested vault prefix', exclude: '/projects/notes/cache/\n' },
  {
    name: 'root directory negation',
    exclude: '/projects/notes/cache/\n',
    root: '!/projects/notes/cache/\n',
  },
  {
    name: 'parent directory negation',
    exclude: '/projects/notes/cache/\n',
    parent: '!notes/cache/\n',
  },
  {
    name: 'excluded ancestor cannot be rescued below',
    exclude: '/projects/\n',
    local: '!cache/keep.md\n',
  },
  { name: 'reopened ancestors', exclude: '/projects/\n', root: '!/projects/\n!/projects/notes/\n' },
  { name: 'root file negation', exclude: '*.md\n', root: '!/projects/notes/cache/keep.md\n' },
  { name: 'gitignore overrides exclude negation', exclude: '!*.md\n', root: '*.md\n' },
  { name: 'unanchored directories and file globs', exclude: 'cache/\n*other*\n' },
  { name: 'last match in source', exclude: '*.md\n!other.md\nother.md\n!other.md\n' },
  {
    name: 'escaped pattern characters',
    exclude: '\\#literal.md\n\\!literal.md\nwith\\ space.md\n',
  },
  { name: 'local file negation', exclude: '*.md\n', local: '!other.md\n' },
];
const leaves = [
  'cache/keep.md',
  'cache/drop.md',
  'nested/cache/keep.md',
  'other.md',
  '#literal.md',
  '!literal.md',
  'with space.md',
];
const paths = ['cache/', 'nested/', 'nested/cache/', ...leaves];

function policy(
  options: {
    includePatterns?: string[];
    ignorePatterns?: string[];
    respectGitignore?: boolean;
  } = {},
) {
  return createIgnorePolicy({
    vaultPath: fixture!.vault,
    ignorePatterns: [],
    includePatterns: [],
    respectGitignore: true,
    ...options,
  });
}

describe('repository exclude selection agrees with Git', () => {
  for (const linked of [false, true]) {
    for (const testCase of cases) {
      it((linked ? 'linked ' : 'regular ') + testCase.name, () => {
        fixture = createGitFixture({ linked, vaultPrefix: prefix });
        writeFileSync(fixture.exclude, testCase.exclude);
        fixture.write('.gitignore', testCase.root ?? '');
        fixture.write('projects/.gitignore', testCase.parent ?? '');
        fixture.write(prefix + '/.gitignore', testCase.local ?? '');
        for (const leaf of leaves) fixture.write(prefix + '/' + leaf, '# Note');
        const selected = policy();
        for (const relative of paths)
          assert.equal(selected.isIgnored(relative), fixture.ignored(relative), relative);
      });
    }
  }
  it('keeps explicit include/ignore precedence and disabled behavior', () => {
    fixture = createGitFixture({ linked: true, vaultPrefix: prefix });
    writeFileSync(fixture.exclude, '/projects/\n');
    fixture.write(prefix + '/rescued/keep.md', '# Kept');
    fixture.write(prefix + '/.obsidian/a.md', '# Operational');
    const selected = policy({ includePatterns: ['rescued/**', '.obsidian/**'] });
    assert.equal(selected.isIgnored('rescued/'), false);
    assert.equal(selected.isIgnored('rescued/keep.md'), false);
    assert.equal(selected.isIgnored('.obsidian/a.md'), true);
    assert.equal(
      policy({ includePatterns: ['rescued/**'], ignorePatterns: ['rescued/**'] }).isIgnored(
        'rescued/keep.md',
      ),
      true,
    );
    fixture.write(prefix + '/.gitignore', '*.md\n');
    const disabled = policy({ respectGitignore: false });
    assert.equal(disabled.isIgnored('rescued/keep.md'), false);
    assert.deepEqual(disabled.controlWatchFiles, []);
  });
  it('tracks absent control files and changes signatures after exclude creation and removal', () => {
    fixture = createGitFixture({ vaultPrefix: prefix });
    rmSync(fixture.exclude);
    const absent = policy();
    assert.ok(absent.controlWatchFiles.includes(fixture.exclude));
    assert.ok(absent.controlWatchFiles.includes(path.join(fixture.repo, '.gitignore')));
    writeFileSync(fixture.exclude, '*.md\n');
    const present = policy();
    assert.notEqual(present.signature(), absent.signature());
    assert.equal(present.isIgnored('note.md'), true);
    rmSync(fixture.exclude);
    assert.equal(policy().signature(), absent.signature());
  });
  it('reports an unreadable exclude source instead of treating it as empty rules', () => {
    fixture = createGitFixture();
    rmSync(fixture.exclude);
    mkdirSync(fixture.exclude);
    assert.throws(
      () => policy(),
      (error: unknown) => error instanceof Error && error.message.includes(fixture!.exclude),
    );
  });
  it('does not discover an independent repository nested below the vault', () => {
    fixture = createGitFixture();
    fixture.write('nested/note.md', '# Nested');
    fixture.git(['init', '--quiet'], path.join(fixture.repo, 'nested'));
    writeFileSync(path.join(fixture.repo, 'nested/.git/info/exclude'), '*.md\n');
    assert.equal(policy().isIgnored('nested/note.md'), false);
  });
});
