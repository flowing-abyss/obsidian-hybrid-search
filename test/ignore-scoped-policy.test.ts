import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    readdirSync: vi.fn(fs.readdirSync),
    readFileSync: vi.fn(fs.readFileSync),
  };
});

const { createIgnorePolicy, createIgnorePolicyForFiles } = await import('../src/ignore.js');

let vaultDir: string;

function write(relativePath: string, content: string): void {
  const fullPath = path.join(vaultDir, relativePath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
}

function compareSelected(paths: readonly string[]): void {
  const full = createIgnorePolicy();
  const scoped = createIgnorePolicyForFiles(paths);
  for (const selected of paths) {
    assert.equal(scoped.isIgnored(selected), full.isIgnored(selected), selected);
  }
  assert.equal('signature' in scoped, false);
}

beforeEach(() => {
  vaultDir = mkdtempSync(path.join(tmpdir(), 'ohs-scoped-ignore-'));
  process.env.OBSIDIAN_VAULT_PATH = vaultDir;
  process.env.OBSIDIAN_RESPECT_GITIGNORE = 'true';
  process.env.OBSIDIAN_IGNORE_PATTERNS = '';
  process.env.OBSIDIAN_INCLUDE_PATTERNS = '';
  vi.mocked(readdirSync).mockClear();
  vi.mocked(readFileSync).mockClear();
});

afterEach(() => {
  rmSync(vaultDir, { recursive: true, force: true });
  delete process.env.OBSIDIAN_VAULT_PATH;
  delete process.env.OBSIDIAN_RESPECT_GITIGNORE;
  delete process.env.OBSIDIAN_IGNORE_PATTERNS;
  delete process.env.OBSIDIAN_INCLUDE_PATTERNS;
});

describe('fresh scoped ignore policy', () => {
  it('matches root and nested Git rules for root files, duplicate paths, and multiple branches', () => {
    write('.gitignore', '*.tmp\na/*.md\n');
    write('a/.gitignore', '!keep.md\n');
    write('a/keep.md', 'kept');
    write('a/drop.md', 'ignored');
    write('other/.gitignore', 'drop.md\n');
    write('other/keep.md', 'kept');
    write('other/drop.md', 'ignored');
    write('root.tmp', 'ignored');

    compareSelected([
      'root.tmp',
      'a/keep.md',
      'a/drop.md',
      'other/keep.md',
      'other/drop.md',
      'a/keep.md',
    ]);
  });

  it('preserves excluded-parent pruning and explicit include rescue', () => {
    write('.gitignore', 'blocked/\nrescue/\n');
    write('blocked/.gitignore', '!note.md\n');
    write('blocked/note.md', 'ignored despite child negation');
    write('rescue/.gitignore', 'note.md\n');
    write('rescue/note.md', 'explicitly included');
    compareSelected(['blocked/note.md', 'rescue/note.md']);

    process.env.OBSIDIAN_INCLUDE_PATTERNS = 'rescue/note.md';
    compareSelected(['blocked/note.md', 'rescue/note.md']);
    assert.equal(createIgnorePolicyForFiles(['rescue/note.md']).isIgnored('rescue/note.md'), false);
  });

  it('preserves cross-layer ancestor reopening and explicit and operational excludes', () => {
    write('.gitignore', 'parent/\n');
    write('parent/.gitignore', '!open/\n');
    write('parent/open/.gitignore', 'blocked.md\n');
    write('parent/open/blocked.md', 'nested rule');
    write('parent/open/kept.md', 'included');
    write('.obsidian/note.md', 'operational');
    process.env.OBSIDIAN_INCLUDE_PATTERNS = 'parent/open/kept.md';
    process.env.OBSIDIAN_IGNORE_PATTERNS = 'parent/open/blocked.md';

    compareSelected(['parent/open/blocked.md', 'parent/open/kept.md', '.obsidian/note.md']);
    assert.equal(
      createIgnorePolicyForFiles(['parent/open/kept.md']).isIgnored('parent/open/kept.md'),
      false,
    );
    assert.equal(
      createIgnorePolicyForFiles(['parent/open/blocked.md']).isIgnored('parent/open/blocked.md'),
      true,
    );
  });

  it('uses physical NFC directory names while matching normalized NFD paths', () => {
    const physical = 'Caf\u00e9';
    const normalized = physical.normalize('NFD');
    write(`${physical}/.gitignore`, 'blocked.md\n');
    write(`${physical}/blocked.md`, 'ignored');
    write(`${physical}/kept.md`, 'kept');
    compareSelected([`${normalized}/blocked.md`, `${physical}/kept.md`]);
    assert.equal(
      createIgnorePolicyForFiles([`${normalized}/blocked.md`]).isIgnored(`${physical}/blocked.md`),
      true,
    );
  });

  it('rereads created, edited, and deleted Git rules without a watcher event', () => {
    write('a/note.md', 'body');
    assert.equal(createIgnorePolicyForFiles(['a/note.md']).isIgnored('a/note.md'), false);
    write('a/.gitignore', 'note.md\n');
    assert.equal(createIgnorePolicyForFiles(['a/note.md']).isIgnored('a/note.md'), true);
    write('a/.gitignore', '!note.md\n');
    assert.equal(createIgnorePolicyForFiles(['a/note.md']).isIgnored('a/note.md'), false);
    rmSync(path.join(vaultDir, 'a/.gitignore'));
    assert.equal(createIgnorePolicyForFiles(['a/note.md']).isIgnored('a/note.md'), false);
    compareSelected(['a/note.md']);
  });

  it('does not traverse unrelated branches or read their rules', () => {
    write('.gitignore', '# root\n');
    write('a/.gitignore', '# relevant\n');
    write('a/b/.gitignore', 'note.md\n');
    write('a/b/note.md', 'body');
    write('sibling/.gitignore', 'note.md\n');
    write('sibling/note.md', 'body');
    vi.mocked(readdirSync).mockClear();
    vi.mocked(readFileSync).mockClear();

    const scoped = createIgnorePolicyForFiles(['a/b/note.md', 'a/b/note.md']);
    assert.equal(scoped.isIgnored('a/b/note.md'), true);
    const visited = vi.mocked(readdirSync).mock.calls.map(([dir]) => String(dir));
    const readRules = vi.mocked(readFileSync).mock.calls.map(([file]) => String(file));
    assert.deepEqual(visited, [vaultDir, path.join(vaultDir, 'a'), path.join(vaultDir, 'a/b')]);
    assert.deepEqual(readRules, [
      path.join(vaultDir, '.gitignore'),
      path.join(vaultDir, 'a/.gitignore'),
      path.join(vaultDir, 'a/b/.gitignore'),
    ]);

    vi.mocked(readdirSync).mockClear();
    createIgnorePolicy();
    assert.ok(
      vi
        .mocked(readdirSync)
        .mock.calls.some(([dir]) => String(dir) === path.join(vaultDir, 'sibling')),
    );
  });

  it('keeps directory symlinks outside the rule traversal', () => {
    write('real/.gitignore', 'note.md\n');
    write('real/note.md', 'body');
    try {
      symlinkSync(path.join(vaultDir, 'real'), path.join(vaultDir, 'alias'), 'dir');
    } catch (error) {
      if (
        process.platform === 'win32' &&
        error instanceof Error &&
        'code' in error &&
        ['EPERM', 'EACCES'].includes(String(error.code))
      )
        return;
      throw error;
    }
    compareSelected(['alias/note.md', 'real/note.md']);
    assert.equal(createIgnorePolicyForFiles(['alias/note.md']).isIgnored('alias/note.md'), false);
  });

  it('falls back to full traversal for unsafe relative paths', () => {
    write('sibling/.gitignore', 'note.md\n');
    write('sibling/note.md', 'body');
    vi.mocked(readdirSync).mockClear();
    createIgnorePolicyForFiles(['../outside.md']);
    assert.ok(
      vi
        .mocked(readdirSync)
        .mock.calls.some(([dir]) => String(dir) === path.join(vaultDir, 'sibling')),
    );
  });

  it('preserves explicit exclusions when Git rules are disabled', () => {
    write('.gitignore', '*.md\n');
    write('nested/note.md', 'body');
    process.env.OBSIDIAN_RESPECT_GITIGNORE = 'false';
    process.env.OBSIDIAN_IGNORE_PATTERNS = 'nested/note.md';
    compareSelected(['nested/note.md', 'root.md']);
    assert.equal(createIgnorePolicyForFiles(['root.md']).isIgnored('root.md'), false);
    assert.equal(createIgnorePolicyForFiles(['nested/note.md']).isIgnored('nested/note.md'), true);
  });
});
