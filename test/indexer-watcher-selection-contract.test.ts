import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, it, vi } from 'vitest';

// Capture the `ignored` predicate handed to chokidar without spawning a real
// watcher. The predicate lives inline in startWatcher(); this is the only way
// to exercise the exact function chokidar v5 calls.
vi.mock('chokidar', () => ({
  watch: vi.fn().mockReturnValue({
    on: vi.fn().mockReturnThis(),
    add: vi.fn().mockReturnThis(),
  }),
}));

const vaultDir = mkdtempSync(path.join(tmpdir(), 'ohs-selection-contract-'));
process.env.OBSIDIAN_VAULT_PATH = vaultDir;
// Include-pattern rescue is the only override that can pull a note back out of
// .gitignore. Keep it explicit so the matrix below is self-describing.
const prevInclude = process.env.OBSIDIAN_INCLUDE_PATTERNS;
process.env.OBSIDIAN_INCLUDE_PATTERNS = 'keep/**';

// Full ignore matrix. `indexed` is the ground truth: does this .md note belong
// in the index (and therefore must the watcher watch it)?
const MATRIX: { rel: string; body: string; indexed: boolean; why: string }[] = [
  { rel: 'note.md', body: '# Note', indexed: true, why: 'plain note at root' },
  { rel: 'sub/nested.md', body: '# Nested', indexed: true, why: 'nested note' },
  { rel: '.obsidian/config.md', body: '# Cfg', indexed: false, why: 'operational: .obsidian/**' },
  {
    rel: 'templates/t.md',
    body: '# T',
    indexed: false,
    why: 'OBSIDIAN_IGNORE default templates/**',
  },
  { rel: 'archive/old.md', body: '# Old', indexed: false, why: 'gitignored dir archive/' },
  { rel: 'keep/rescued.md', body: '# Keep', indexed: true, why: 'gitignored but include-rescued' },
];

// Non-.md files: never indexed, and the watcher must not watch them either
// (except .gitignore, handled as a documented exception below).
const NON_MD = ['readme.txt', 'diagram.canvas'];

const abs = (rel: string): string => path.join(vaultDir, rel);
const toRel = (full: string): string => path.relative(vaultDir, full).split(path.sep).join('/');

let ignored: (p: string) => boolean;
let scanSet: Set<string>;

beforeAll(async () => {
  // .gitignore: hide archive/ and keep/ (keep/ is rescued via include pattern).
  writeFileSync(abs('.gitignore'), 'archive/\nkeep/\n');
  for (const { rel, body } of MATRIX) {
    mkdirSync(path.dirname(abs(rel)), { recursive: true });
    writeFileSync(abs(rel), body);
  }
  for (const rel of NON_MD) writeFileSync(abs(rel), 'x');

  vi.resetModules();
  const { startWatcher, scanVault } = await import('../src/indexer');
  startWatcher(512);
  await new Promise((r) => setTimeout(r, 50));

  const chokidar = await import('chokidar');
  const watchMock = chokidar.watch as ReturnType<typeof vi.fn>;
  const options = watchMock.mock.calls.at(-1)?.[1] as { ignored: (p: string) => boolean };
  ignored = options.ignored;

  scanSet = new Set(scanVault().map(toRel));
});

afterAll(() => {
  rmSync(vaultDir, { recursive: true, force: true });
  if (prevInclude === undefined) delete process.env.OBSIDIAN_INCLUDE_PATTERNS;
  else process.env.OBSIDIAN_INCLUDE_PATTERNS = prevInclude;
});

describe('scanVault selects exactly the intended notes', () => {
  for (const { rel, indexed, why } of MATRIX) {
    it(`${indexed ? 'includes' : 'excludes'} ${rel} (${why})`, () => {
      assert.equal(scanSet.has(rel), indexed, `${rel} scanVault membership (${why})`);
    });
  }

  it('excludes non-markdown files', () => {
    for (const rel of NON_MD) {
      assert.equal(scanSet.has(rel), false, `${rel} must not be scanned`);
    }
  });
});

describe('watcher ignored() predicate matches scanVault (no silent divergence)', () => {
  // This is the invariant the chokidar v5 regression broke: whatever the
  // indexer would index, the watcher MUST watch, and vice versa. If these ever
  // diverge, the index silently goes stale — exactly issue #31.
  for (const { rel, indexed, why } of MATRIX) {
    it(`${rel}: watched ⟺ indexed (${why})`, () => {
      const isWatched = ignored(abs(rel)) === false;
      assert.equal(isWatched, indexed, `${rel}: watcher/indexer must agree (${why})`);
      // And both must agree with scanVault.
      assert.equal(isWatched, scanSet.has(rel), `${rel}: predicate must track scanVault`);
    });
  }

  it('non-markdown files are not watched', () => {
    for (const rel of NON_MD) {
      assert.equal(ignored(abs(rel)), true, `${rel} must be ignored by the watcher`);
    }
  });
});

describe('watcher ignored() predicate: directory & root handling', () => {
  it('never ignores the vault root (chokidar v5 asks about the root itself)', () => {
    assert.equal(ignored(vaultDir), false, 'vault root must never be ignored');
  });

  it('prunes operational and ignored directories', () => {
    assert.equal(ignored(abs('.obsidian')), true, '.obsidian/ must be pruned');
    assert.equal(ignored(abs('templates')), true, 'templates/ must be pruned');
    assert.equal(ignored(abs('archive')), true, 'gitignored archive/ must be pruned');
  });

  it('descends into normal and include-rescued directories', () => {
    assert.equal(ignored(abs('sub')), false, 'sub/ must be watched');
    assert.equal(ignored(abs('keep')), false, 'include-rescued keep/ must be watched');
  });
});

describe('watcher ignored() predicate: documented exceptions', () => {
  it('watches .gitignore even though it is never indexed', () => {
    // The watcher intentionally watches .gitignore (to re-evaluate the policy
    // on change) while scanVault never indexes it (not a .md). This is the one
    // path where "watched" and "indexed" legitimately differ.
    assert.equal(ignored(abs('.gitignore')), false, '.gitignore must be watched');
    assert.equal(scanSet.has('.gitignore'), false, '.gitignore must never be indexed');
  });
});
