/**
 * Contract for OBSIDIAN_IGNORE_PATTERNS (issue #52) and for .gitignore rules.
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
 *  C5 – .gitignore rules obey the same directory invariant, on disk and end to end.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
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

const {
  closeDb,
  openDb,
  initVecTable,
  getDb,
  getPathsToRemoveForIgnoreChange,
  upsertNote,
  upsertLinks,
  upsertMarkdownLinks,
} = await import('../src/db.js');

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
const {
  scanVault,
  indexVaultSync,
  cleanupStaleNotes,
  indexFile,
  startBackgroundIndexing,
  startWatcher,
  withIndexingDbLock,
} = await import('../src/indexer.js');
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

function ancestorDirs(notePath: string): string[] {
  const segments = notePath.split('/').slice(0, -1);
  return segments.map((_, i) => segments.slice(0, i + 1).join('/') + '/');
}

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
  // File patterns that would match any made-up probe file; they must not prune folders.
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
        for (const dir of ancestorDirs(p)) {
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

// ─────────────────────────────────────────────────────────────────────────────
// C5 – .gitignore rules and directories
//
// A directory may be pruned only when a rule matches the directory itself. Asking
// whether a made-up file inside it would be ignored is not the same question: `_*`
// or `*.md` say yes for every folder, and a `!` rule can re-include a real note.
// ─────────────────────────────────────────────────────────────────────────────

interface GitignoreCase {
  gitignore: string;
  nested?: Record<string, string>;
  include?: string[];
  ignored: string[];
  kept: string[];
  pruned?: string[];
}

const gitEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
);
Object.assign(gitEnv, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });

function runGit(vault: string, args: string[]) {
  // Git is a required test tool, resolved from the runner's PATH on every platform.
  // eslint-disable-next-line sonarjs/no-os-command-from-path
  return spawnSync('git', args, { cwd: vault, env: gitEnv, encoding: 'utf8' });
}

function gitIgnores(vault: string, rel: string): boolean {
  const result = runGit(vault, [
    '-c',
    'core.excludesFile=/dev/null',
    'check-ignore',
    '--no-index',
    '--quiet',
    '--',
    rel.replace(/\/$/, ''),
  ]);
  assert.ok(result.status === 0 || result.status === 1, result.stderr);
  return result.status === 0;
}

const GITIGNORE_CASES: GitignoreCase[] = [
  {
    gitignore: '_*\n',
    ignored: ['notes/_draft.md', '_private/a.md'],
    kept: ['notes/x.md', 'notes/sub/y.md', 'root.md'],
    pruned: ['_private/'],
  },
  {
    gitignore: '*.md\n!notes/x.md\n',
    ignored: ['root.md', 'notes/other.md'],
    kept: ['notes/x.md'],
  },
  {
    gitignore: 'foo/*\n!foo/keep.md\n',
    ignored: ['foo/drop.md'],
    kept: ['foo/keep.md', 'notes/x.md'],
  },
  {
    gitignore: '*probe*\n',
    ignored: ['notes/probe-results.md'],
    kept: ['notes/x.md'],
  },
  // Rules that do name a directory keep pruning it.
  {
    gitignore: 'node_modules/\nbuild\n**/cache/\n',
    ignored: ['node_modules/pkg/r.md', 'a/node_modules/r.md', 'build/out.md', 'a/cache/c.md'],
    kept: ['notes/x.md', 'a/cached.md'],
    pruned: ['node_modules/', 'a/node_modules/', 'build/', 'a/cache/'],
  },
  // `out/` itself stays walkable, as in git, where `!out/keep.md` would still be legal.
  {
    gitignore: 'out/**\n',
    ignored: ['out/a.md', 'out/deep/b.md'],
    kept: ['notes/out/a.md'],
    pruned: ['out/deep/'],
  },
  // A nested .gitignore can re-include what a parent rule hides.
  {
    gitignore: '_*\n',
    nested: { sub: '!_keep.md\n' },
    ignored: ['sub/_drop.md', '_keep.md'],
    kept: ['sub/_keep.md'],
  },
  // Include patterns rescue a gitignored folder whatever wildcard they start with.
  {
    gitignore: 'notes/\n',
    include: ['no?es/*.md'],
    ignored: ['notes/deep/y.md'],
    kept: ['notes/x.md'],
  },
  {
    gitignore: 'notes/\n',
    include: ['[a-n]otes/*.md'],
    ignored: ['notes/deep/y.md'],
    kept: ['notes/x.md'],
  },
  {
    gitignore: 'cache\n',
    nested: { a: '!keep.md\n' },
    ignored: ['a/cache/keep.md'],
    kept: ['a/keep.md'],
    pruned: ['a/cache/'],
  },
  {
    gitignore: '*\n',
    nested: { nothing: '!x.md\n' },
    include: ['n*es/*.md'],
    ignored: ['nothing/x.md', 'notes/deep/y.md'],
    kept: ['notes/x.md'],
  },
  { gitignore: 'cache/\n', nested: { a: '!cache/\n' }, ignored: [], kept: ['a/cache/keep.md'] },
  {
    gitignore: 'cache/\n*.md\n',
    nested: { a: '!cache/\n' },
    ignored: ['a/cache/keep.md'],
    kept: [],
  },
  {
    gitignore: 'cache/\n',
    nested: { a: '!cache/\n', 'a/cache': '*.md\n!keep.md\n' },
    ignored: ['a/cache/drop.md'],
    kept: ['a/cache/keep.md'],
  },
  {
    gitignore: 'cache/\n',
    nested: { 'a/cache': '!keep.md\n' },
    ignored: ['a/cache/keep.md'],
    kept: [],
    pruned: ['a/cache/'],
  },
  {
    gitignore: 'cache/\n',
    nested: { a: '!/cache/\n' },
    ignored: ['a/deep/cache/keep.md'],
    kept: ['a/cache/keep.md'],
  },
  {
    gitignore: 'cache/\n',
    nested: { a: '!cache/\ncache/\n' },
    ignored: ['a/cache/keep.md'],
    kept: [],
  },
  {
    gitignore: 'cache/\n',
    nested: { a: 'cache/\n!cache/\n' },
    ignored: [],
    kept: ['a/cache/keep.md'],
  },
  {
    gitignore: 'cache/\n',
    nested: { 'lit[ab]': '!cache/\n' },
    ignored: [],
    kept: ['lit[ab]/cache/keep.md'],
  },
  {
    gitignore: 'cache/\n',
    nested: { ['й'.normalize('NFD')]: '!cache/\n' },
    ignored: [],
    kept: ['й/cache/keep.md'.normalize('NFD')],
  },
];

describe('C5 – .gitignore rules and directories', () => {
  const gitignoreVault = mkdtempSync(path.join(tmpdir(), 'ohs-ignore-contract-gi-'));

  afterAll(() => rmSync(gitignoreVault, { recursive: true, force: true }));

  function gitignorePolicy({
    gitignore,
    nested = {},
    include = [],
    ignored = [],
    kept = [],
    pruned = [],
  }: Partial<GitignoreCase>) {
    rmSync(gitignoreVault, { recursive: true, force: true });
    mkdirSync(gitignoreVault, { recursive: true });
    writeFileSync(path.join(gitignoreVault, '.gitignore'), gitignore ?? '');
    for (const [dir, content] of Object.entries(nested)) {
      mkdirSync(path.join(gitignoreVault, dir), { recursive: true });
      writeFileSync(path.join(gitignoreVault, dir, '.gitignore'), content);
    }
    for (const rel of [...ignored, ...kept, ...pruned]) {
      const full = path.join(gitignoreVault, rel);
      if (rel.endsWith('/')) mkdirSync(full, { recursive: true });
      else {
        mkdirSync(path.dirname(full), { recursive: true });
        writeFileSync(full, 'fixture');
      }
    }
    return createIgnorePolicy({
      vaultPath: gitignoreVault,
      ignorePatterns: [],
      includePatterns: include,
      respectGitignore: true,
    });
  }

  for (const testCase of GITIGNORE_CASES) {
    const { gitignore, nested, include, ignored, kept, pruned = [] } = testCase;
    it(JSON.stringify({ gitignore, nested, include }), () => {
      const policy = gitignorePolicy(testCase);
      for (const p of ignored) assert.equal(policy.isIgnored(p), true, `should ignore ${p}`);
      for (const p of pruned) assert.equal(policy.isIgnored(p), true, `should prune ${p}`);
      for (const p of kept) {
        assert.equal(policy.isIgnored(p), false, `should keep ${p}`);
        for (const dir of ancestorDirs(p)) {
          assert.equal(policy.isIgnored(dir), false, `prunes ${dir} but keeps ${p}`);
        }
      }
      assert.equal(policy.isIgnored(''), false);
      if (!include?.length) {
        const init = runGit(gitignoreVault, ['init', '--quiet']);
        assert.equal(init.status, 0, init.stderr);
        const queries = new Set(
          [...ignored, ...kept, ...pruned].flatMap((rel) => [rel, ...ancestorDirs(rel)]),
        );
        for (const rel of queries)
          assert.equal(policy.isIgnored(rel), gitIgnores(gitignoreVault, rel), rel);
      }
    });
  }

  it('allows an exact application include only for its matching path', () => {
    const policy = gitignorePolicy({
      gitignore: '*\n',
      nested: { nothing: '!x.md\n' },
      include: ['nothing/x.md'],
      ignored: ['nothing/y.md'],
      kept: ['nothing/x.md'],
    });
    assert.equal(policy.isIgnored('nothing/x.md'), false);
    assert.equal(policy.isIgnored('nothing/y.md'), true);
  });

  it.each(['n*es/*.md', 'no?es/*.md', '[a-n]otes/*.md'])(
    'keeps the matching wildcard include %s',
    (pattern) => {
      const policy = gitignorePolicy({
        gitignore: 'notes/\n',
        include: [pattern],
        kept: ['notes/x.md'],
        ignored: ['notes/deep/y.md'],
      });
      assert.equal(policy.isIgnored('notes/x.md'), false);
      assert.equal(policy.isIgnored('notes/deep/y.md'), true);
    },
  );

  it.skipIf(process.platform === 'win32')('keeps an escaped literal-star include', () => {
    const policy = gitignorePolicy({
      gitignore: '*otes/\n',
      include: ['\\*otes/*.md'],
      kept: ['*otes/x.md'],
    });
    assert.equal(policy.isIgnored('*otes/x.md'), false);
  });

  it('matches escaped literal-star and wildcard ancestor names as logical paths', () => {
    gitignorePolicy({ gitignore: '*otes/\ncache/\n' });
    const literalInclude = createIgnorePolicy({
      vaultPath: gitignoreVault,
      ignorePatterns: [],
      includePatterns: ['\\*otes/*.md'],
      respectGitignore: true,
    });
    assert.equal(literalInclude.isIgnored('*otes/x.md'), false);
    for (const name of ['lit*', 'lit?']) {
      assert.equal(literalInclude.isIgnored(`${name}/cache/keep.md`), true);
    }
  });

  it('does not let includes override operational or explicit exclusions', () => {
    const policy = gitignorePolicy({
      gitignore: '*\n',
      include: ['.obsidian/**', 'notes/**'],
      ignored: ['.obsidian/plugins/x.md', 'notes/x.md'],
    });
    assert.equal(policy.isIgnored('.obsidian/plugins/x.md'), true);
    const explicit = createIgnorePolicy({
      vaultPath: gitignoreVault,
      ignorePatterns: ['notes/**'],
      includePatterns: ['notes/**'],
      respectGitignore: true,
    });
    assert.equal(explicit.isIgnored('notes/x.md'), true);
  });

  it('respects disabled Git rules', () => {
    gitignorePolicy({ gitignore: 'cache/\n', ignored: ['cache/x.md'] });
    const disabled = createIgnorePolicy({
      vaultPath: gitignoreVault,
      ignorePatterns: [],
      includePatterns: [],
      respectGitignore: false,
    });
    assert.equal(disabled.isIgnored('cache/x.md'), false);
  });

  it('normalizes NFC queries against NFD Git rules and paths', () => {
    const nfd = 'й'.normalize('NFD');
    const policy = gitignorePolicy({ gitignore: `${nfd}/\n`, ignored: [`${nfd}/x.md`] });
    assert.equal(policy.isIgnored(`${nfd}/x.md`), true);
    assert.equal(policy.isIgnored('й/x.md'.normalize('NFC')), true);
  });

  it.skipIf(process.platform === 'win32')(
    'handles literal wildcard characters in reopened ancestor names',
    () => {
      for (const dirname of ['lit*', 'lit?']) {
        const rel = `${dirname}/cache/keep.md`;
        const policy = gitignorePolicy({
          gitignore: 'cache/\n',
          nested: { [dirname]: '!cache/\n' },
          kept: [rel],
        });
        assert.equal(policy.isIgnored(rel), false);
        const init = runGit(gitignoreVault, ['init', '--quiet']);
        assert.equal(init.status, 0, init.stderr);
        assert.equal(gitIgnores(gitignoreVault, rel), false);
      }
    },
  );

  it.skipIf(process.platform === 'win32')('keeps literal LF in generated ancestor rules', () => {
    const rel = 'a\ncache/cache/keep.md';
    const policy = gitignorePolicy({ gitignore: '', kept: [rel] });
    assert.equal(policy.isIgnored(rel), false);
    const init = runGit(gitignoreVault, ['init', '--quiet']);
    assert.equal(init.status, 0, init.stderr);
    assert.equal(gitIgnores(gitignoreVault, rel), false);
  });

  it('still prunes the internal .obsidian folder', () => {
    const policy = gitignorePolicy({});
    assert.equal(policy.isIgnored('.obsidian/'), true);
    assert.equal(policy.isIgnored('.obsidian/plugins/'), true);
    assert.equal(policy.isIgnored('notes/.obsidian/'), false);
  });

  describe('end to end', () => {
    const FILES: Record<string, string> = {
      'GI/notes/x.md': 'gitignore survivor zqgisurvivor',
      'GI/notes/sub/y.md': 'gitignore survivor zqgisurvivor',
      'GI/notes/_draft.md': 'gitignore hidden zqgihidden',
      'GI/foo/keep.md': 'gitignore survivor zqgisurvivor',
      'GI/foo/drop.md': 'gitignore hidden zqgihidden',
      'GI/node_modules/pkg/r.md': 'gitignore hidden zqgihidden',
    };
    const SURVIVORS = ['GI/foo/keep.md', 'GI/notes/sub/y.md', 'GI/notes/x.md'];

    beforeAll(() => {
      for (const [rel, content] of Object.entries(FILES)) {
        const full = path.join(vaultDir, rel);
        mkdirSync(path.dirname(full), { recursive: true });
        writeFileSync(full, `# ${path.basename(rel, '.md')}\n\n${content}\n`);
      }
      writeFileSync(
        path.join(vaultDir, 'GI', '.gitignore'),
        '_*\nfoo/*\n!foo/keep.md\nnode_modules/\n',
      );
      openDb();
      initVecTable(EMBEDDING.length);
    });

    beforeEach(() => {
      process.env.OBSIDIAN_IGNORE_PATTERNS = 'templates/**';
      process.env.OBSIDIAN_RESPECT_GITIGNORE = 'true';
    });

    afterAll(() => {
      process.env.OBSIDIAN_RESPECT_GITIGNORE = 'false';
      rmSync(path.join(vaultDir, 'GI'), { recursive: true, force: true });
    });

    it('scans, indexes and finds exactly the notes git would keep', async () => {
      const scanned = sorted(
        scanVault()
          .map((f) => path.relative(vaultDir, f).replaceAll(path.sep, '/'))
          .filter((p) => p.startsWith('GI/')),
      );
      assert.deepEqual(scanned, SURVIVORS);

      const result = await indexVaultSync(true);
      assert.equal(result.errors.length, 0);
      assert.deepEqual(
        indexedPaths().filter((p) => p.startsWith('GI/')),
        SURVIVORS,
      );

      bumpIndexVersion();
      assert.deepEqual(await search('zqgihidden', { mode: 'fulltext' }), []);
      const found = await search('zqgisurvivor', { mode: 'fulltext' });
      assert.deepEqual(sorted(found.map((h) => h.path)), SURVIVORS);
    });
  });
});

describe('issue #55 – index entry points and saved-version migration', () => {
  const previous = {
    ignore: process.env.OBSIDIAN_IGNORE_PATTERNS,
    include: process.env.OBSIDIAN_INCLUDE_PATTERNS,
    respect: process.env.OBSIDIAN_RESPECT_GITIGNORE,
    debounce: config.debounce,
  };

  function write(rel: string, content: string): void {
    const full = path.join(vaultDir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }

  beforeEach(() => {
    closeDb();
    rmSync(vaultDir, { recursive: true, force: true });
    mkdirSync(vaultDir, { recursive: true });
    process.env.OBSIDIAN_IGNORE_PATTERNS = '';
    process.env.OBSIDIAN_INCLUDE_PATTERNS = '';
    process.env.OBSIDIAN_RESPECT_GITIGNORE = 'true';
    openDb();
    initVecTable(EMBEDDING.length);
    vi.mocked(embedder.embed).mockClear();
    vi.mocked(embedder.embedDetailed).mockClear();
  });

  afterAll(() => {
    config.debounce = previous.debounce;
    for (const [key, value] of [
      ['OBSIDIAN_IGNORE_PATTERNS', previous.ignore],
      ['OBSIDIAN_INCLUDE_PATTERNS', previous.include],
      ['OBSIDIAN_RESPECT_GITIGNORE', previous.respect],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  for (const { name, rules, rel, include } of [
    {
      name: 'blocked nested file negation',
      rules: { '.gitignore': 'cache\n', 'a/.gitignore': '!keep.md\n' },
      rel: 'a/cache/keep.md',
      include: '',
    },
    {
      name: 'unmatched include wildcard',
      rules: { '.gitignore': '*\n', 'nothing/.gitignore': '!x.md\n' },
      rel: 'nothing/x.md',
      include: 'n*es/*.md',
    },
  ]) {
    it(`skips ${name} in scan, direct, force and background indexing`, async () => {
      process.env.OBSIDIAN_INCLUDE_PATTERNS = include;
      for (const [rule, content] of Object.entries(rules)) write(rule, content);
      write(rel, '# Excluded\n\nNonempty body for embedding');
      if (include) write('notes/x.md', '# Included\n\nNonempty body');
      const target = path.join(vaultDir, rel);
      vi.mocked(embedder.embed).mockClear();
      vi.mocked(embedder.embedDetailed).mockClear();
      const scanned = scanVault();
      assert.ok(!scanned.includes(target));
      if (include) assert.ok(scanned.includes(path.join(vaultDir, 'notes/x.md')));
      assert.equal(await indexFile(target, 512), 'skipped');
      assert.equal(await indexFile(target, 512, true), 'skipped');
      assert.equal(getDb().prepare('SELECT id FROM notes WHERE path = ?').get(rel), undefined);
      assert.equal(vi.mocked(embedder.embed).mock.calls.length, 0);
      assert.equal(vi.mocked(embedder.embedDetailed).mock.calls.length, 0);
      await startBackgroundIndexing(512);
      assert.equal(getDb().prepare('SELECT id FROM notes WHERE path = ?').get(rel), undefined);
      if (include)
        assert.ok(getDb().prepare('SELECT id FROM notes WHERE path = ?').get('notes/x.md'));
    });
  }

  it('sweeps version-2 selections while preserving saved survivor vectors and ignored-note links', async () => {
    process.env.OBSIDIAN_INCLUDE_PATTERNS = 'UP55/wide/n*es/*.md';
    write('UP55/.gitignore', 'cache\n');
    write('UP55/a/.gitignore', '!keep.md\n');
    write('UP55/a/cache/keep.md', 'body of erroneously included note');
    write('UP55/wide/.gitignore', '*\n');
    write('UP55/wide/nothing/.gitignore', '!x.md\n');
    write('UP55/wide/nothing/x.md', 'body of erroneously included note');
    write('UP55/wide/notes/kept.md', 'already explicitly included body');
    write('UP55/unaffected.md', 'ordinary body');

    const survivorPaths = ['UP55/unaffected.md', 'UP55/wide/notes/kept.md'];
    const removedPaths = ['UP55/a/cache/keep.md', 'UP55/wide/nothing/x.md'];
    function seedSavedNote(rel: string): void {
      const raw = readFileSync(path.join(vaultDir, rel), 'utf8');
      upsertNote({
        path: rel.normalize('NFD'),
        title: rel,
        tags: [],
        content: raw,
        hash: createHash('md5').update(raw).digest('hex'),
        mtime: statSync(path.join(vaultDir, rel)).mtimeMs,
        chunks: [{ text: raw, embedding: EMBEDDING }],
      });
    }
    function savedRows(paths: readonly string[]) {
      return paths.map((rel) => ({
        note: getDb().prepare('SELECT id, path, hash, mtime FROM notes WHERE path = ?').get(rel),
        chunks: getDb()
          .prepare(
            `SELECT c.id, c.note_id, hex(v.embedding) AS vector
          FROM chunks c JOIN notes n ON n.id = c.note_id
          JOIN vec_chunks v ON v.chunk_id = c.id WHERE n.path = ? ORDER BY c.id`,
          )
          .all(rel),
      }));
    }
    function linkRows() {
      return {
        wiki: getDb()
          .prepare('SELECT from_path, to_path FROM links ORDER BY from_path, to_path')
          .all(),
        markdown: getDb()
          .prepare('SELECT from_path, to_path FROM markdown_links ORDER BY from_path, to_path')
          .all(),
      };
    }
    for (const rel of [...survivorPaths, ...removedPaths]) seedSavedNote(rel);
    for (const rel of removedPaths) {
      upsertLinks(rel, ['UP55/unaffected.md']);
      upsertMarkdownLinks(rel, ['UP55/unaffected.md']);
    }
    const before = savedRows(survivorPaths);
    const removedChunks = removedPaths.flatMap((rel) => savedRows([rel])[0]!.chunks) as {
      id: number;
    }[];
    const linksBefore = linkRows();
    assert.ok(before.every((row) => row.chunks.length > 0));
    assert.equal(removedChunks.length, 2);
    const version2 = JSON.parse(createIgnorePolicy().signature()) as Record<string, unknown>;
    version2.matcherVersion = 2;
    getPathsToRemoveForIgnoreChange([], JSON.stringify(version2), () => false);
    vi.mocked(embedder.embed).mockClear();
    vi.mocked(embedder.embedDetailed).mockClear();
    cleanupStaleNotes();
    for (const rel of removedPaths) {
      assert.equal(getDb().prepare('SELECT id FROM notes WHERE path = ?').get(rel), undefined);
      assert.equal(existsSync(path.join(vaultDir, rel)), true);
      assert.equal(
        readFileSync(path.join(vaultDir, rel), 'utf8'),
        'body of erroneously included note',
      );
      assert.equal(await indexFile(path.join(vaultDir, rel), 512, true), 'skipped');
    }
    for (const { id } of removedChunks) {
      assert.equal(getDb().prepare('SELECT id FROM chunks WHERE id = ?').get(id), undefined);
      assert.equal(
        getDb().prepare('SELECT chunk_id FROM vec_chunks WHERE chunk_id = ?').get(id),
        undefined,
      );
    }
    assert.deepEqual(savedRows(survivorPaths), before);
    assert.deepEqual(linkRows(), linksBefore);
    const signature = getDb()
      .prepare("SELECT value FROM settings WHERE key = 'ignore_state_signature'")
      .get() as { value: string };
    assert.equal((JSON.parse(signature.value) as { matcherVersion: number }).matcherVersion, 3);

    const result = await indexVaultSync();
    assert.deepEqual(result.errors, []);
    assert.equal(result.indexed, 0);
    assert.deepEqual(savedRows(survivorPaths), before);
    assert.deepEqual(linkRows(), linksBefore);
    cleanupStaleNotes(new Set(scanVault().map((f) => path.relative(vaultDir, f).normalize('NFD'))));
    const repeated = await indexVaultSync();
    assert.deepEqual(repeated.errors, []);
    assert.equal(repeated.indexed, 0);
    assert.deepEqual(savedRows(survivorPaths), before);
    assert.deepEqual(linkRows(), linksBefore);
    assert.equal(vi.mocked(embedder.embed).mock.calls.length, 0);
    assert.equal(vi.mocked(embedder.embedDetailed).mock.calls.length, 0);

    upsertLinks('UP55/unaffected.md', ['UP55/wide/notes/kept.md']);
    upsertMarkdownLinks('UP55/unaffected.md', ['UP55/wide/notes/kept.md']);
    assert.ok(
      linkRows().wiki.some(
        (row) => (row as { from_path: string }).from_path === 'UP55/unaffected.md',
      ),
    );
    unlinkSync(path.join(vaultDir, 'UP55/unaffected.md'));
    await indexVaultSync();
    assert.equal(
      getDb().prepare('SELECT id FROM notes WHERE path = ?').get('UP55/unaffected.md'),
      undefined,
    );
    assert.ok(
      !linkRows().wiki.some(
        (row) => (row as { from_path: string }).from_path === 'UP55/unaffected.md',
      ),
    );
    assert.ok(
      !linkRows().markdown.some(
        (row) => (row as { from_path: string }).from_path === 'UP55/unaffected.md',
      ),
    );
  });

  it('rechecks a queued watcher change against fresh Git rules under the DB lock', async () => {
    config.debounce = 20;
    write('a/.gitignore', '!keep.md\n');
    write('a/cache/keep.md', '# Initially allowed\n\nNonempty body');
    const chokidar = await import('chokidar');
    vi.mocked(chokidar.watch).mockClear();
    startWatcher(512);
    await vi.waitFor(() => assert.ok(vi.mocked(chokidar.watch).mock.results.length > 0));
    type MockWatcher = { on: ReturnType<typeof vi.fn> };
    const watcher = vi.mocked(chokidar.watch).mock.results.at(-1)?.value as MockWatcher;
    const change = watcher.on.mock.calls.find(([event]) => event === 'change')?.[1] as (
      file: string,
    ) => void;
    assert.equal(typeof change, 'function');
    let release: () => void = () => {
      throw new Error('lock not acquired');
    };
    let entered: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = withIndexingDbLock(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
        entered();
      });
    });
    await ready;
    try {
      change(path.join(vaultDir, 'a/cache/keep.md'));
      await new Promise((resolve) => setTimeout(resolve, config.debounce + 50));
      write('.gitignore', 'cache\n');
    } finally {
      release();
    }
    await held;
    await withIndexingDbLock(() => {});
    assert.equal(
      getDb().prepare('SELECT id FROM notes WHERE path = ?').get('a/cache/keep.md'),
      undefined,
    );
    assert.equal(vi.mocked(embedder.embed).mock.calls.length, 0);
    assert.equal(vi.mocked(embedder.embedDetailed).mock.calls.length, 0);
  });
});
