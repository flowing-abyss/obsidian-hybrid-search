/**
 * Contract for OBSIDIAN_IGNORE_PATTERNS (issue #52).
 *
 * A pattern that silently matches nothing is the failure mode this file guards
 * against: the user sees no error, and generated folders end up in search results.
 *
 *  C1 – Pattern semantics: one table of pattern → path → expected, plus the
 *       invariant that a directory is never pruned while a note inside it is kept.
 *  C2 – No silent no-ops: every pattern the README or the defaults advertise
 *       matches its own example.
 *  C3 – End to end: real files on disk, real scan, real index, real search.
 *  C4 – Upgrade: notes indexed by an older matcher are swept as newly ignored.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, it, vi } from 'vitest';

vi.mock('chokidar', () => ({
  watch: vi.fn().mockReturnValue({
    add: vi.fn().mockReturnThis(),
    on: vi.fn().mockReturnThis(),
  }),
}));

const vaultDir = mkdtempSync(path.join(tmpdir(), 'ohs-ignore-contract-'));
process.env.OBSIDIAN_VAULT_PATH = vaultDir;
process.env.OBSIDIAN_RESPECT_GITIGNORE = 'false';
delete process.env.OBSIDIAN_IGNORE_PATTERNS;

const { config } = await import('../src/config.js');
const DEFAULT_PATTERNS = [...config.ignorePatterns];

const { closeDb, openDb, initVecTable, getDb, getPathsToRemoveForIgnoreChange } =
  await import('../src/db.js');

const embedder = await import('../src/embedder.js');
const EMBEDDING = new Float32Array([0.1, 0.2, 0.3, 0.4]);
vi.spyOn(embedder, 'embed').mockResolvedValue([EMBEDDING]);
vi.spyOn(embedder, 'embedDetailed').mockImplementation((texts: string[]) =>
  Promise.resolve(texts.map(() => ({ ok: true as const, embedding: EMBEDDING }))),
);
vi.spyOn(embedder, 'getContextLength').mockResolvedValue(512);
vi.spyOn(embedder, 'getDocumentTokenPolicy').mockResolvedValue({
  limit: 508,
  count: (text) => Math.ceil(Array.from(text).length / 4),
});

const { createIgnorePolicy } = await import('../src/ignore.js');
const { scanVault, indexVaultSync, cleanupStaleNotes } = await import('../src/indexer.js');
const { search, bumpIndexVersion } = await import('../src/searcher.js');

function policyFor(ignorePatterns: string[]) {
  return createIgnorePolicy({
    vaultPath: vaultDir,
    ignorePatterns,
    includePatterns: [],
    respectGitignore: false,
  });
}

const sorted = (paths: string[]): string[] => [...paths].sort((a, b) => a.localeCompare(b));

function indexedPaths(): string[] {
  return sorted(
    (getDb().prepare('SELECT path FROM notes').all() as { path: string }[]).map((r) => r.path),
  );
}

afterAll(() => {
  closeDb();
  delete process.env.OBSIDIAN_IGNORE_PATTERNS;
  delete process.env.OBSIDIAN_RESPECT_GITIGNORE;
  rmSync(vaultDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// C1 – Pattern semantics
// ─────────────────────────────────────────────────────────────────────────────

interface Case {
  pattern: string;
  ignored: string[];
  kept: string[];
}

const CASES: Case[] = [
  // Root-anchored forms. These predate glob support and must not drift.
  {
    pattern: 'templates/**',
    ignored: ['templates/daily.md', 'templates/sub/weekly.md', 'templates/'],
    kept: ['notes/templates/daily.md', 'templates-overview.md', 'my-templates/a.md'],
  },
  {
    pattern: '*.canvas',
    ignored: ['board.canvas', 'deep/dir/board.canvas'],
    kept: ['board.canvas.md', 'canvas.md'],
  },
  {
    pattern: 'exact/path.md',
    ignored: ['exact/path.md'],
    kept: ['other/exact/path.md', 'exact/path.md.bak.md', 'exact/other.md'],
  },
  {
    pattern: 'drafts',
    ignored: ['drafts/a.md', 'drafts/'],
    kept: ['notes/drafts/a.md', 'drafts-2024/a.md'],
  },
  // Spelling variants of a root-level folder.
  {
    pattern: 'node_modules/',
    ignored: ['node_modules/pkg/README.md', 'node_modules/'],
    kept: ['Memory/app/node_modules/pkg/README.md'],
  },
  {
    pattern: '/rooted/**',
    ignored: ['rooted/a.md', 'rooted/'],
    kept: ['notes/rooted/a.md'],
  },
  {
    pattern: './dotted/**',
    ignored: ['dotted/a.md'],
    kept: ['notes/dotted/a.md'],
  },
  // Brackets are legal in folder names and stay literal.
  {
    pattern: '[Archive]/**',
    ignored: ['[Archive]/a.md'],
    kept: ['A/a.md', 'Archive/a.md'],
  },
  // Negation is not supported and must stay inert rather than order-dependent.
  {
    pattern: '!**/keep/**',
    ignored: [],
    kept: ['keep/a.md', 'notes/keep/a.md'],
  },
  // Glob forms. Before #52 every one of these matched nothing.
  {
    pattern: '**/node_modules/**',
    ignored: [
      'node_modules/pkg/README.md',
      'Memory/app/node_modules/pkg/README.md',
      'Memory/app/node_modules/',
    ],
    kept: ['Memory/app/notes.md', 'Memory/node_modules-notes.md', 'Memory/app/'],
  },
  {
    pattern: '**/.beads/**',
    ignored: ['.beads/a.md', 'Memory/app/.beads/a.md'],
    kept: ['Memory/app/beads.md'],
  },
  {
    pattern: '**/drafts',
    ignored: ['drafts/a.md', 'notes/drafts/a.md', 'a/b/drafts/c.md'],
    kept: ['notes/drafts-2024/a.md'],
  },
  {
    pattern: '**/*.excalidraw.md',
    ignored: ['sketch.excalidraw.md', 'a/b/sketch.excalidraw.md'],
    kept: ['a/b/sketch.md'],
  },
  {
    pattern: 'Archive/*/old/**',
    ignored: ['Archive/2020/old/n.md', 'Archive/2021/old/deep/n.md'],
    kept: ['Archive/2020/new/n.md', 'Archive/old/n.md', 'Other/2020/old/n.md'],
  },
  {
    pattern: 'Journal/202?/**',
    ignored: ['Journal/2024/jan.md'],
    kept: ['Journal/1999/jan.md', 'Journal/20245/jan.md'],
  },
  {
    pattern: './**/cache/',
    ignored: ['cache/a.md', 'notes/cache/a.md', 'notes/cache/'],
    kept: ['notes/cache.md', 'notes/cached/a.md'],
  },
  // Globs are case-sensitive, like the root-anchored forms.
  {
    pattern: '**/Attic/**',
    ignored: ['notes/Attic/a.md'],
    kept: ['notes/attic/a.md'],
  },
  // These match the internal directory-probe file name; they must not prune folders.
  {
    pattern: '**/_*',
    ignored: ['notes/_draft.md', '_private/a.md', 'notes/_private/'],
    kept: ['notes/x.md', 'root.md'],
  },
  {
    pattern: 'Archive/*.md',
    ignored: ['Archive/a.md'],
    kept: ['Archive/sub/n.md'],
  },
  {
    pattern: 'plugin-*/**',
    ignored: ['plugin-tasks/data.md', 'plugin-/x.md'],
    kept: ['plugins/data.md', 'notes/plugin-tasks/data.md'],
  },
];

describe('C1 – ignore pattern semantics', () => {
  for (const { pattern, ignored, kept } of CASES) {
    describe(pattern, () => {
      const policy = policyFor([pattern]);
      for (const p of ignored) {
        it(`ignores ${p}`, () => assert.equal(policy.isIgnored(p), true));
      }
      for (const p of kept) {
        it(`keeps ${p}`, () => assert.equal(policy.isIgnored(p), false));
      }
    });
  }

  it('never prunes a directory while a note inside it is kept', () => {
    for (const { pattern, kept } of CASES) {
      const policy = policyFor([pattern]);
      for (const p of kept) {
        const segments = p.split('/').slice(0, -1);
        for (let i = 1; i <= segments.length; i++) {
          const dir = segments.slice(0, i).join('/') + '/';
          assert.equal(policy.isIgnored(dir), false, `${pattern} prunes ${dir} but keeps ${p}`);
        }
      }
    }
  });

  it('prunes the directory itself for every folder pattern', () => {
    for (const [pattern, dir] of [
      ['templates/**', 'templates/'],
      ['**/node_modules/**', 'a/b/node_modules/'],
      ['Archive/*/old/**', 'Archive/2020/old/'],
      ['**/drafts', 'notes/drafts/'],
      ['plugin-*/**', 'plugin-tasks/'],
      ['Journal/202?/**', 'Journal/2024/'],
      ['./**/cache/', 'notes/cache/'],
    ] as const) {
      assert.equal(policyFor([pattern]).isIgnored(dir), true, `${pattern} should prune ${dir}`);
    }
  });

  it('combining patterns never un-ignores a path another pattern ignores', () => {
    const all = policyFor(CASES.map((c) => c.pattern));
    for (const { ignored } of CASES) {
      for (const p of ignored) assert.equal(all.isIgnored(p), true, p);
    }
  });

  it('matches NFC input against NFD-stored paths and patterns', () => {
    const policy = policyFor(['**/Вложения/**'.normalize('NFC')]);
    assert.equal(policy.isIgnored('Проект/Вложения/й.md'.normalize('NFD')), true);
    assert.equal(policy.isIgnored('Проект/Вложения/й.md'.normalize('NFC')), true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C2 – No silent no-ops
//
// Whatever the README bullets or the defaults advertise needs an example path
// here, and the matcher has to satisfy it. Documenting a new pattern form without
// one fails, instead of the pattern being accepted and quietly doing nothing.
// ─────────────────────────────────────────────────────────────────────────────

describe('C2 – every advertised pattern can match something', () => {
  const EXAMPLES: Record<string, string> = {
    '.obsidian/**': '.obsidian/plugins/x/data.md',
    'templates/**': 'templates/daily.md',
    'folder/**': 'folder/sub/note.md',
    '*.canvas': 'boards/plan.canvas',
    'exact/path.md': 'exact/path.md',
    '**/node_modules/**': 'Memory/app/node_modules/pkg/README.md',
  };

  const readme = readFileSync(path.join(import.meta.dirname, '..', 'README.md'), 'utf-8');
  const section = readme.slice(readme.indexOf('### Ignore patterns'));
  const documented = [...section.matchAll(/^- Use `([^`]+)` to ignore/gm)].map((m) => m[1]!);

  it('finds the documented patterns in the README', () => {
    assert.ok(documented.length >= 4, `parsed only: ${documented.join(', ')}`);
  });

  for (const pattern of new Set([...documented, ...DEFAULT_PATTERNS])) {
    it(`${pattern} matches its example`, () => {
      const example = EXAMPLES[pattern];
      assert.ok(example, `${pattern} is advertised but has no example path in this test`);
      assert.equal(policyFor([pattern]).isIgnored(example), true);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// C3 / C4 – End to end on a real vault
// ─────────────────────────────────────────────────────────────────────────────

const VAULT_FILES: Record<string, string> = {
  'templates/daily.md': 'daily template zqtemplate',
  'Projects/app/node_modules/lib/README.md': 'dependency readme zqdependency',
  'Memory/app/node_modules/lib/README.md': 'dependency readme zqdependency',
  'Memory/app/graphify-out/report.md': 'generated report zqgenerated, see [[notes]]',
  'Memory/app/notes.md': 'real project notes zqreal',
  'Inbox/idea.md': 'real inbox idea zqreal',
};
const REAL_NOTES = ['Inbox/idea.md', 'Memory/app/notes.md'];
const USER_PATTERNS = 'templates/**,Projects/**,**/node_modules/**,**/graphify-out/**';

function linksFrom(notePath: string): number {
  return (
    getDb().prepare('SELECT COUNT(*) AS c FROM links WHERE from_path = ?').get(notePath) as {
      c: number;
    }
  ).c;
}

describe('C3/C4 – real vault, real index', () => {
  beforeAll(() => {
    for (const [rel, content] of Object.entries(VAULT_FILES)) {
      const full = path.join(vaultDir, rel);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, `# ${path.basename(rel, '.md')}\n\n${content}\n`);
    }
    openDb();
    initVecTable(EMBEDDING.length);
  });

  describe('C4 – upgrading from a release whose matcher ignored the glob patterns', () => {
    const STALE = 'Memory/app/graphify-out/report.md';

    beforeAll(async () => {
      // The index an old release would have built: only root-anchored patterns worked.
      process.env.OBSIDIAN_IGNORE_PATTERNS = 'templates/**,Projects/**';
      await indexVaultSync(true);
      // ...while the user had the glob patterns configured all along, and the stored
      // signature had no matcher version. Key order must match signature() in ignore.ts.
      process.env.OBSIDIAN_IGNORE_PATTERNS = USER_PATTERNS;
      const legacy = JSON.parse(createIgnorePolicy().signature()) as Record<string, unknown>;
      delete legacy.matcherVersion;
      getPathsToRemoveForIgnoreChange(
        USER_PATTERNS.split(','),
        JSON.stringify(legacy),
        () => false,
      );
    });

    it('sweeps them as newly ignored, keeping their links', () => {
      assert.ok(indexedPaths().includes(STALE), 'precondition: the generated note is indexed');
      assert.ok(linksFrom(STALE) > 0, 'precondition: the generated note has links');

      // No fsPaths: only the signature-driven sweep can remove anything here.
      cleanupStaleNotes();
      assert.deepEqual(indexedPaths(), REAL_NOTES);
      assert.ok(linksFrom(STALE) > 0, 'links of a newly ignored note must survive the sweep');

      cleanupStaleNotes();
      assert.deepEqual(indexedPaths(), REAL_NOTES, 'the following run is a no-op');
    });
  });

  describe('C3 – indexing and search with the glob patterns active', () => {
    beforeEach(() => {
      process.env.OBSIDIAN_IGNORE_PATTERNS = USER_PATTERNS;
    });

    it('scanVault never yields files under an ignored directory', () => {
      const rel = sorted(
        scanVault().map((f) => path.relative(vaultDir, f).replaceAll(path.sep, '/')),
      );
      assert.deepEqual(rel, REAL_NOTES);
    });

    it('a full reindex keeps ignored content out of the index and out of search', async () => {
      const result = await indexVaultSync(true);
      assert.equal(result.errors.length, 0);
      assert.deepEqual(indexedPaths(), REAL_NOTES);

      bumpIndexVersion();
      for (const term of ['zqdependency', 'zqgenerated', 'zqtemplate']) {
        const hits = await search(term, { mode: 'fulltext' });
        assert.deepEqual(
          hits.map((h) => h.path),
          [],
          term,
        );
      }
      const real = await search('zqreal', { mode: 'fulltext' });
      assert.deepEqual(sorted(real.map((h) => h.path)), REAL_NOTES);
    });

    it('removing the patterns brings the notes back', async () => {
      process.env.OBSIDIAN_IGNORE_PATTERNS = 'templates/**';
      await indexVaultSync();
      assert.ok(indexedPaths().includes('Memory/app/graphify-out/report.md'));
    });
  });
});
