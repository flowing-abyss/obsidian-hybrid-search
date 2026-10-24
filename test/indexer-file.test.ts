import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, it, vi } from 'vitest';

vi.mock('chokidar', () => ({
  watch: vi.fn().mockReturnValue({
    close: vi.fn().mockResolvedValue(undefined),
    add: vi.fn().mockReturnThis(),
    on: vi.fn().mockReturnThis(),
  }),
}));

const vaultDir = mkdtempSync(path.join(tmpdir(), 'ohs-indexer-file-test-'));
process.env.OBSIDIAN_VAULT_PATH = vaultDir;

const {
  closeDb,
  openDb,
  wipeDatabaseFiles,
  getNoteByPath,
  getDb,
  initVecTable,
  isLikelyDatabaseCorruption,
} = await import('./helpers/owned-storage.js');

// Spy on embedder *before* importing indexer so live bindings pick up the mocks
const embedder = await import('../src/inference/embedder.js');
vi.spyOn(embedder, 'embed').mockResolvedValue([new Float32Array([0.1, 0.2, 0.3, 0.4])]);
vi.spyOn(embedder, 'embedDetailed').mockImplementation((texts: string[]) =>
  Promise.resolve(
    texts.map(() => ({
      ok: true as const,
      embedding: new Float32Array([0.1, 0.2, 0.3, 0.4]),
    })),
  ),
);
vi.spyOn(embedder, 'getContextLength').mockResolvedValue(512);
vi.spyOn(embedder, 'getDocumentTokenPolicy').mockResolvedValue({
  limit: 508,
  count: (text) => Math.ceil(Array.from(text).length / 4),
});

describe('indexFile oversized embedding recovery', () => {
  it('persists issue-derived URL and reference content only as accepted source-aligned leaves', async () => {
    const filePath = path.join(vaultDir, 'issue-33.md');
    const body = [
      '# Asset Catalog',
      '',
      '![wrapped image](https://example.com/image%20with%20spaces%2Fand%3Fquery%3Dvalue.png)',
      'Asset description keeps the image section source-aligned.',
      '',
      '## References',
      '- [encoded](https://example.com/a%20very%20long%2Freference%3Fone%3Dtwo%26three%3Dfour)',
      '- [second](https://example.com/another%2Freally%2Flong%2Freference%3Ffive%3Dsix)',
    ].join('\n');
    writeFileSync(filePath, `---\ntitle: ${'Issue Prefix '.repeat(8)}\n---\n${body}`);
    const detailedSpy = vi.mocked(embedder.embedDetailed);
    vi.mocked(embedder.getDocumentTokenPolicy).mockResolvedValueOnce({
      limit: 48,
      count: (text) => Array.from(text).length,
    });
    detailedSpy.mockImplementation((texts: string[]) =>
      Promise.resolve(
        texts.map((text) =>
          Array.from(text).length <= 36
            ? { ok: true as const, embedding: new Float32Array([0.1, 0.2, 0.3, 0.4]) }
            : { ok: false as const, kind: 'input_too_long', status: 400, message: 'too long' },
        ),
      ),
    );

    try {
      const result = await indexFile(filePath, 32);
      assert.equal(result, 'indexed');
      const note = getNoteByPath('issue-33.md');
      assert.ok(note);
      assert.equal(note.content, body);
      const rows = getDb()
        .prepare(
          `SELECT chunk_index, text, heading_path, embedding_status, char_start, char_end
           FROM chunks WHERE note_id = ? ORDER BY chunk_index`,
        )
        .all(note.id) as Array<{
        chunk_index: number;
        text: string;
        heading_path: string | null;
        embedding_status: string;
        char_start: number;
        char_end: number;
      }>;
      assert.ok(rows.length > 3, 'expected provider rejection to produce multiple leaves');
      assert.deepEqual(
        rows.map((row) => row.chunk_index),
        rows.map((_, index) => index),
      );
      for (const row of rows) {
        assert.equal(row.embedding_status, 'ok');
        assert.equal(row.text, body.slice(row.char_start, row.char_end));
      }
      for (let index = 1; index < rows.length; index++) {
        assert.ok(rows[index - 1]!.char_start <= rows[index]!.char_start);
      }
      for (let index = 0; index < body.length; index++) {
        if (/\s/.test(body[index]!)) continue;
        assert.ok(
          rows.some((row) => row.char_start <= index && row.char_end > index),
          `source character at ${index} was not covered by an accepted leaf`,
        );
      }
      assert.ok(
        rows.some((row) => row.heading_path?.includes('## References')),
        JSON.stringify(rows.map((row) => [row.text, row.heading_path])),
      );
      assert.ok(detailedSpy.mock.calls.length > 1);
    } finally {
      detailedSpy.mockImplementation((texts: string[]) =>
        Promise.resolve(
          texts.map(() => ({
            ok: true as const,
            embedding: new Float32Array([0.1, 0.2, 0.3, 0.4]),
          })),
        ),
      );
    }
  });
});

const {
  indexFile,
  indexFileWithRecovery,
  scanVault,
  populateMissingLinks,
  populateMissingMarkdownReferences,
  cleanupStaleNotes,
  formatDuration,
  renderProgressLine,
  startBackgroundIndexing,
  getIndexingStatus,
  resetIndexingState,
  indexVaultSync,
} = await import('./helpers/owned-indexer.js');

beforeAll(() => {
  openDb();
  initVecTable(4);
});

afterAll(() => {
  closeDb();
  rmSync(vaultDir, { recursive: true, force: true });
});

// ─── formatDuration ──────────────────────────────────────────────────────────

describe('formatDuration', () => {
  it('formats seconds only', () => {
    assert.equal(formatDuration(45), '45s');
  });

  it('formats minutes only', () => {
    assert.equal(formatDuration(120), '2m');
  });

  it('formats minutes and seconds', () => {
    assert.equal(formatDuration(125), '2m 5s');
  });

  it('rounds to nearest second', () => {
    assert.equal(formatDuration(59.4), '59s');
    assert.equal(formatDuration(59.6), '1m');
  });
});

// ─── renderProgressLine ──────────────────────────────────────────────────────

describe('renderProgressLine', () => {
  it('renders 0% progress', () => {
    const line = renderProgressLine(0, 10, '');
    assert.ok(line.includes('0%'));
    assert.ok(line.includes('(0/10 notes)'));
  });

  it('renders 100% progress', () => {
    const line = renderProgressLine(10, 10, ' — 1m remaining');
    assert.ok(line.includes('100%'));
    assert.ok(line.includes('(10/10 notes)'));
    assert.ok(line.includes('1m remaining'));
  });

  it('has the correct width', () => {
    const line = renderProgressLine(5, 10, '');
    const barMatch = /[█░]+/.exec(line);
    assert.ok(barMatch);
    assert.equal(barMatch[0].length, 20);
  });
});

// ─── scanVault / walkDir ─────────────────────────────────────────────────────

describe('scanVault', () => {
  const scanVaultRelPaths = (): string[] =>
    scanVault().map((file) => path.relative(vaultDir, file).split(path.sep).join('/'));

  it('finds markdown files in the vault', () => {
    writeFileSync(path.join(vaultDir, 'found.md'), '# Found');
    const files = scanVault();
    assert.ok(files.some((f) => f.endsWith('found.md')));
  });

  it('ignores non-markdown files', () => {
    writeFileSync(path.join(vaultDir, 'readme.txt'), 'text');
    const files = scanVault();
    assert.ok(!files.some((f) => f.endsWith('readme.txt')));
  });

  it('recurses into subdirectories', () => {
    mkdirSync(path.join(vaultDir, 'sub'), { recursive: true });
    writeFileSync(path.join(vaultDir, 'sub', 'nested.md'), '# Nested');
    const files = scanVault();
    assert.ok(files.some((f) => f.endsWith('nested.md')));
  });

  it('skips ignored directories', () => {
    mkdirSync(path.join(vaultDir, 'templates'), { recursive: true });
    writeFileSync(path.join(vaultDir, 'templates', 't.md'), '# T');
    const files = scanVault();
    assert.ok(!files.some((f) => f.includes('templates')));
  });

  it('respects root .gitignore rules during scan', () => {
    const gitignorePath = path.join(vaultDir, '.gitignore');
    const ignoredPath = path.join(vaultDir, 'ignored-by-git.md');
    const visiblePath = path.join(vaultDir, 'visible-after-gitignore.md');
    writeFileSync(gitignorePath, 'ignored-by-git.md\n');
    writeFileSync(ignoredPath, '# Ignored');
    writeFileSync(visiblePath, '# Visible');

    try {
      const files = scanVault();

      assert.ok(!files.some((f) => f.endsWith('ignored-by-git.md')));
      assert.ok(files.some((f) => f.endsWith('visible-after-gitignore.md')));
    } finally {
      rmSync(gitignorePath, { force: true });
      rmSync(ignoredPath, { force: true });
      rmSync(visiblePath, { force: true });
    }
  });

  it('applies nested .gitignore only to descendants', () => {
    const projectDir = path.join(vaultDir, 'project-gitignore-scope');
    const rootDraftPath = path.join(vaultDir, 'draft.md');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(path.join(projectDir, '.gitignore'), 'draft.md\n');
    writeFileSync(path.join(projectDir, 'draft.md'), '# Ignored nested draft');
    writeFileSync(rootDraftPath, '# Root draft');

    try {
      const files = scanVaultRelPaths();

      assert.ok(!files.includes('project-gitignore-scope/draft.md'));
      assert.ok(files.includes('draft.md'));
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(rootDraftPath, { force: true });
    }
  });

  it('discovers nested .gitignore files under unicode directory names', () => {
    const unicodeDir = path.join(vaultDir, 'Café-project');
    mkdirSync(unicodeDir, { recursive: true });
    writeFileSync(path.join(unicodeDir, '.gitignore'), 'hidden.md\n');
    writeFileSync(path.join(unicodeDir, 'hidden.md'), '# Hidden unicode');
    writeFileSync(path.join(unicodeDir, 'visible.md'), '# Visible unicode');

    try {
      const files = scanVaultRelPaths();

      assert.ok(!files.includes('Café-project/hidden.md'));
      assert.ok(files.includes('Café-project/visible.md'));
    } finally {
      rmSync(unicodeDir, { recursive: true, force: true });
    }
  });

  it('descends into gitignored directories when include patterns can re-include notes', () => {
    const oldInclude = process.env.OBSIDIAN_INCLUDE_PATTERNS;
    const gitignorePath = path.join(vaultDir, '.gitignore');
    const keepDir = path.join(vaultDir, 'gitignored-keep');
    process.env.OBSIDIAN_INCLUDE_PATTERNS = 'gitignored-keep/reincluded.md';
    mkdirSync(keepDir, { recursive: true });
    writeFileSync(gitignorePath, 'gitignored-keep/\n');
    writeFileSync(path.join(keepDir, 'hidden.md'), '# Hidden');
    writeFileSync(path.join(keepDir, 'reincluded.md'), '# Reincluded');

    try {
      const files = scanVaultRelPaths();

      assert.ok(!files.includes('gitignored-keep/hidden.md'));
      assert.ok(files.includes('gitignored-keep/reincluded.md'));
    } finally {
      if (oldInclude === undefined) delete process.env.OBSIDIAN_INCLUDE_PATTERNS;
      else process.env.OBSIDIAN_INCLUDE_PATTERNS = oldInclude;
      rmSync(gitignorePath, { force: true });
      rmSync(keepDir, { recursive: true, force: true });
    }
  });
});

// ─── indexFile ───────────────────────────────────────────────────────────────

describe('indexFile', () => {
  it('indexes a new markdown file', async () => {
    const filePath = path.join(vaultDir, 'new-note.md');
    writeFileSync(filePath, '# New Note\n\nSome content here.');
    const result = await indexFile(filePath, 512);
    assert.equal(result, 'indexed');
    const note = getNoteByPath('new-note.md');
    if (!note) throw new Error('expected note');
    assert.equal(note.title, 'new-note');
  });

  it('skips a file when mtime is unchanged', async () => {
    const filePath = path.join(vaultDir, 'mtime-skip.md');
    writeFileSync(filePath, '# Mtime Skip\n\nContent.');
    const first = await indexFile(filePath, 512);
    assert.equal(first, 'indexed');
    const second = await indexFile(filePath, 512);
    assert.equal(second, 'skipped');
  });

  it('skips a file when content hash is unchanged but mtime changed', async () => {
    const filePath = path.join(vaultDir, 'hash-skip.md');
    writeFileSync(filePath, '# Hash Skip\n\nContent.');
    const first = await indexFile(filePath, 512);
    assert.equal(first, 'indexed');

    // Change mtime without changing content by touching the file
    const newMtime = new Date(Date.now() + 1000);
    const fs = await import('node:fs');
    fs.utimesSync(filePath, newMtime, newMtime);

    const second = await indexFile(filePath, 512);
    assert.equal(second, 'skipped');
  });

  it('re-indexes when force=true', async () => {
    const filePath = path.join(vaultDir, 'force-reindex.md');
    writeFileSync(filePath, '# Force\n\nContent.');
    await indexFile(filePath, 512);
    const second = await indexFile(filePath, 512, true);
    assert.equal(second, 'indexed');
  });

  it('returns error for a non-existent file', async () => {
    const result = await indexFile(path.join(vaultDir, 'no-such-file.md'), 512);
    assert.ok(typeof result === 'object' && 'error' in result);
  });

  it('skips files ignored by current policy', async () => {
    wipeDatabaseFiles();
    openDb();
    initVecTable(4);

    const gitignorePath = path.join(vaultDir, '.gitignore');
    const filePath = path.join(vaultDir, 'direct-ignored.md');
    writeFileSync(gitignorePath, 'direct-ignored.md\n');
    writeFileSync(filePath, '# Direct Ignored\n\nShould not be indexed.');

    try {
      const result = await indexFile(filePath, 512);

      assert.equal(result, 'skipped');
      assert.ok(!getNoteByPath('direct-ignored.md'));
    } finally {
      rmSync(gitignorePath, { force: true });
      rmSync(filePath, { force: true });
    }
  });

  it('does not reopen SQLite for a provider error containing database corruption text', async () => {
    const file = path.join(vaultDir, 'provider-corruption-text.md');
    writeFileSync(file, 'Provider failure text');
    vi.mocked(embedder.embedDetailed).mockRejectedValueOnce(
      new Error('database disk image is malformed'),
    );
    const recovery = vi.fn();
    const result = await indexFileWithRecovery(file, 512, false, recovery);
    assert.equal(typeof result, 'object');
    assert.equal(recovery.mock.calls.length, 0);
    assert.equal(getNoteByPath('provider-corruption-text.md'), undefined);
  });

  it('indexes frontmatter tags and aliases', async () => {
    const filePath = path.join(vaultDir, 'fm-note.md');
    writeFileSync(
      filePath,
      '---\ntitle: FM Title\ntags: [tag-a, tag-b]\naliases:\n  - Alias One\n---\n\nBody.',
    );
    await indexFile(filePath, 512);
    const note = getNoteByPath('fm-note.md');
    if (!note) throw new Error('expected note');
    const tags = JSON.parse(note.tags) as string[];
    assert.ok(tags.includes('tag-a'));
    assert.ok(tags.includes('tag-b'));
  });
});

// ─── populateMissingLinks ────────────────────────────────────────────────────

describe('populateMissingLinks', () => {
  it('populates links from existing note content', async () => {
    wipeDatabaseFiles();
    openDb();
    initVecTable(4);

    const db = getDb();
    db.prepare(
      'INSERT INTO notes (path, title, tags, content, frontmatter, mtime, hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('link-source.md', 'Source', '[]', 'See [[link-target]] for more.', '', 1, 'h1');
    db.prepare(
      'INSERT INTO notes (path, title, tags, content, frontmatter, mtime, hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('link-target.md', 'Target', '[]', 'Target content.', '', 1, 'h2');

    await populateMissingLinks();

    const links = db
      .prepare('SELECT to_path FROM links WHERE from_path = ?')
      .all('link-source.md') as { to_path: string }[];
    assert.ok(links.some((l) => l.to_path === 'link-target.md'));
  });

  it('is idempotent (settings flag prevents re-run)', async () => {
    await populateMissingLinks();
    const db = getDb();
    const flag = db.prepare("SELECT value FROM settings WHERE key = 'links_v1'").get() as
      { value: string } | undefined;
    assert.equal(flag?.value, '1');

    // Second call should be a no-op
    await populateMissingLinks();
    const flag2 = db.prepare("SELECT value FROM settings WHERE key = 'links_v1'").get() as
      { value: string } | undefined;
    assert.equal(flag2?.value, '1');
  });
});

// ─── populateMissingMarkdownReferences ───────────────────────────────────────

describe('populateMissingMarkdownReferences', () => {
  it('populates markdown links and URLs from existing note content', async () => {
    wipeDatabaseFiles();
    openDb();
    initVecTable(4);

    const db = getDb();
    db.prepare(
      'INSERT INTO notes (path, title, tags, content, frontmatter, mtime, hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'folder/source.md',
      'Source',
      '[]',
      'See [Target](../target.md) and https://second.example then https://first.example.',
      '',
      1,
      'h1',
    );
    db.prepare(
      'INSERT INTO notes (path, title, tags, content, frontmatter, mtime, hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('target.md', 'Target', '[]', 'Target content.', '', 1, 'h2');

    await populateMissingMarkdownReferences();

    const links = db
      .prepare('SELECT to_path FROM markdown_links WHERE from_path = ?')
      .all('folder/source.md') as { to_path: string }[];
    assert.deepEqual(
      links.map((link) => link.to_path),
      ['target.md'],
    );

    const urls = db
      .prepare('SELECT url FROM note_urls WHERE from_path = ? ORDER BY position ASC')
      .all('folder/source.md') as { url: string }[];
    assert.deepEqual(
      urls.map((row) => row.url),
      ['https://second.example', 'https://first.example'],
    );

    const flag = db.prepare("SELECT value FROM settings WHERE key = 'markdown_links_v1'").get() as
      { value: string } | undefined;
    assert.equal(flag?.value, '1');
  });

  it('is idempotent once the settings flag is present', async () => {
    await populateMissingMarkdownReferences();
    const db = getDb();
    db.prepare('DELETE FROM markdown_links').run();

    await populateMissingMarkdownReferences();

    const count = db.prepare('SELECT COUNT(*) as c FROM markdown_links').get() as { c: number };
    assert.equal(count.c, 0);
  });
});

// ─── cleanupStaleNotes ───────────────────────────────────────────────────────

describe('cleanupStaleNotes', () => {
  it('removes notes deleted from filesystem', () => {
    wipeDatabaseFiles();
    openDb();
    initVecTable(4);

    const db = getDb();
    db.prepare(
      'INSERT INTO notes (path, title, tags, content, frontmatter, mtime, hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('gone.md', 'Gone', '[]', 'Content.', '', 1, 'h1');

    cleanupStaleNotes(new Set<string>());
    const note = getNoteByPath('gone.md');
    assert.ok(!note);
  });

  it('keeps notes that still exist on disk', () => {
    wipeDatabaseFiles();
    openDb();
    initVecTable(4);
    writeFileSync(path.join(vaultDir, 'still-here.md'), '# Still Here');
    const db = getDb();
    db.prepare(
      'INSERT INTO notes (path, title, tags, content, frontmatter, mtime, hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('still-here.md', 'Still', '[]', 'Content.', '', 1, 'h1');

    cleanupStaleNotes(new Set(['still-here.md']));
    const note = getNoteByPath('still-here.md');
    assert.ok(note);
  });

  it('removes notes newly ignored by .gitignore', async () => {
    wipeDatabaseFiles();
    openDb();
    initVecTable(4);

    const filePath = path.join(vaultDir, 'gitignore-cleanup.md');
    const gitignorePath = path.join(vaultDir, '.gitignore');
    writeFileSync(filePath, '# Gitignore Cleanup\n\nBefore ignore.');
    await indexFile(filePath, 512);
    assert.ok(getNoteByPath('gitignore-cleanup.md'));

    writeFileSync(gitignorePath, 'gitignore-cleanup.md\n');
    try {
      cleanupStaleNotes(new Set(['gitignore-cleanup.md']));
      assert.ok(!getNoteByPath('gitignore-cleanup.md'));
    } finally {
      rmSync(gitignorePath, { force: true });
      rmSync(filePath, { force: true });
    }
  });
});

// ─── startBackgroundIndexing ─────────────────────────────────────────────────

describe('startBackgroundIndexing', () => {
  it('enqueues vault files and reports progress', async () => {
    writeFileSync(path.join(vaultDir, 'bg-note.md'), '# BG Note');

    // Reset state
    wipeDatabaseFiles();
    openDb();
    initVecTable(4);
    resetIndexingState();

    void startBackgroundIndexing(512);

    // Wait for queue to drain
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        const status = getIndexingStatus();
        if (!status.isRunning) {
          clearInterval(interval);
          resolve();
        }
      }, 50);
    });

    const status = getIndexingStatus();
    assert.equal(status.queued, 0);
    assert.equal(status.isRunning, false);

    const note = getNoteByPath('bg-note.md');
    assert.ok(note);
    // Clean up global state so other test files see idle defaults
    resetIndexingState();
  });

  it('handles empty vault gracefully', async () => {
    const emptyVault = mkdtempSync(path.join(tmpdir(), 'ohs-bg-empty-'));
    const originalVault = process.env.OBSIDIAN_VAULT_PATH;
    process.env.OBSIDIAN_VAULT_PATH = emptyVault;

    try {
      wipeDatabaseFiles();
      openDb();
      initVecTable(4);
      resetIndexingState();

      await startBackgroundIndexing(512);

      const status = getIndexingStatus();
      assert.equal(status.queued, 0);
      assert.equal(status.total, 0);
      assert.equal(status.isRunning, false);
    } finally {
      closeDb();
      process.env.OBSIDIAN_VAULT_PATH = originalVault;
      rmSync(emptyVault, { recursive: true, force: true });
    }
  });

  it('reports failed background work without marking the index fresh', async () => {
    wipeDatabaseFiles();
    openDb();
    initVecTable(4);
    resetIndexingState();
    writeFileSync(path.join(vaultDir, 'bg-error.md'), 'Background failure');
    vi.mocked(embedder.embedDetailed).mockRejectedValueOnce(new Error('provider unavailable'));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await startBackgroundIndexing(512);
      assert.ok(stderr.mock.calls.some((call) => String(call[0]).includes('provider unavailable')));
      assert.equal(
        getDb().prepare("SELECT value FROM settings WHERE key='last_indexed'").get(),
        undefined,
      );
    } finally {
      stderr.mockRestore();
    }
  });

  it('records provider corruption text as a background failure without SQLite recovery', async () => {
    wipeDatabaseFiles();
    openDb();
    initVecTable(4);
    resetIndexingState();
    writeFileSync(path.join(vaultDir, 'bg-provider.md'), 'Background provider message');
    vi.mocked(embedder.embedDetailed).mockRejectedValueOnce(
      new Error('database disk image is malformed'),
    );
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await startBackgroundIndexing(512);
      assert.ok(stderr.mock.calls.some((call) => String(call[0]).includes('malformed')));
      assert.ok(stderr.mock.calls.every((call) => !String(call[0]).includes('[auto-heal]')));
    } finally {
      stderr.mockRestore();
    }
  });
});

// ─── indexVaultSync ──────────────────────────────────────────────────────────

describe('indexVaultSync', () => {
  it('indexes all vault files and returns result counts', async () => {
    writeFileSync(path.join(vaultDir, 'sync-a.md'), '# Sync A');
    writeFileSync(path.join(vaultDir, 'sync-b.md'), '# Sync B');

    wipeDatabaseFiles();
    openDb();
    initVecTable(4);
    resetIndexingState();

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const result = await indexVaultSync(false, 'Test indexing...');

    assert.ok(result.indexed >= 0);
    assert.ok(result.skipped >= 0);
    assert.ok(Array.isArray(result.errors));

    stderrSpy.mockRestore();
  });

  it('force=true re-indexes existing files', async () => {
    const filePath = path.join(vaultDir, 'force-sync.md');
    writeFileSync(filePath, '# Force Sync');

    wipeDatabaseFiles();
    openDb();
    initVecTable(4);
    resetIndexingState();

    const first = await indexVaultSync(false);
    assert.ok(first.indexed > 0);

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const second = await indexVaultSync(true);
    assert.ok(second.indexed > 0 || second.skipped > 0);
    stderrSpy.mockRestore();
  });

  it('reports errors to stderr when indexing fails', async () => {
    const filePath = path.join(vaultDir, 'error-test.md');
    writeFileSync(filePath, '# Error Test\n\nSome content here.', 'utf-8');

    wipeDatabaseFiles();
    openDb();
    initVecTable(4);
    resetIndexingState();

    // Make the next embed call fail
    const embedSpy = embedder.embedDetailed as ReturnType<typeof vi.fn>;
    embedSpy.mockRejectedValueOnce(new Error('embed failure'));

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const result = await indexVaultSync(false, 'Test indexing...');

    assert.ok(result.errors.length > 0, 'expected at least one error');
    assert.ok(
      stderrSpy.mock.calls.some((c) => c[0]?.toString().includes('embed failure')),
      'expected error message in stderr',
    );
    stderrSpy.mockRestore();
  });

  it('does not mark freshness after a provider error containing corruption text', async () => {
    wipeDatabaseFiles();
    openDb();
    initVecTable(4);
    resetIndexingState();
    writeFileSync(path.join(vaultDir, 'corrupt-db-error.md'), 'Corrupt provider message');
    vi.mocked(embedder.embedDetailed).mockRejectedValueOnce(
      new Error('database disk image is malformed'),
    );
    const result = await indexVaultSync(false, 'Test indexing...');
    assert.ok(result.errors.some((error) => error.error.includes('malformed')));
    assert.equal(
      getDb().prepare("SELECT value FROM settings WHERE key='last_indexed'").get(),
      undefined,
    );
  });

  it('does not mark the index fresh when requireClean sees non-corruption errors', async () => {
    const filePath = path.join(vaultDir, 'require-clean-error.md');
    writeFileSync(filePath, '# Require Clean Error\\n\\nSome content here.', 'utf-8');

    wipeDatabaseFiles();
    openDb();
    initVecTable(4);
    resetIndexingState();

    const embedSpy = embedder.embedDetailed as ReturnType<typeof vi.fn>;
    embedSpy.mockRejectedValueOnce(new Error('embedding API unavailable'));

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await assert.rejects(
      () => indexVaultSync(false, 'Test indexing...', { requireClean: true }),
      /index freshness was not updated/,
    );

    const lastIndexed = getDb()
      .prepare("SELECT value FROM settings WHERE key = 'last_indexed'")
      .get() as { value: string } | undefined;
    assert.equal(lastIndexed, undefined);

    stderrSpy.mockRestore();
  });

  it('returns zero counts for empty vault', async () => {
    const emptyVault = mkdtempSync(path.join(tmpdir(), 'ohs-empty-'));
    const originalVault = process.env.OBSIDIAN_VAULT_PATH;
    process.env.OBSIDIAN_VAULT_PATH = emptyVault;

    try {
      wipeDatabaseFiles();
      openDb();
      initVecTable(4);
      resetIndexingState();

      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const result = await indexVaultSync(false);
      stderrSpy.mockRestore();

      assert.equal(result.indexed, 0);
      assert.equal(result.skipped, 0);
      assert.equal(result.errors.length, 0);
    } finally {
      closeDb();
      process.env.OBSIDIAN_VAULT_PATH = originalVault;
      rmSync(emptyVault, { recursive: true, force: true });
    }
  });

  it('renders TTY progress bar when stderr is a TTY', async () => {
    const filePath = path.join(vaultDir, 'tty-note.md');
    writeFileSync(filePath, '# TTY Note\n\nContent here.');

    wipeDatabaseFiles();
    openDb();
    initVecTable(4);
    resetIndexingState();

    const originalIsTTY = process.stderr.isTTY;
    process.stderr.isTTY = true;

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await indexVaultSync(false);

    assert.ok(
      stderrSpy.mock.calls.some((c) => c[0]?.toString().includes('\r\x1b[2K')),
      'expected TTY progress bar with carriage return and clear line',
    );

    stderrSpy.mockRestore();
    process.stderr.isTTY = originalIsTTY;
  });

  it('cleanupStaleNotes removes notes matching updated ignore patterns', async () => {
    wipeDatabaseFiles();
    openDb();
    initVecTable(4);

    const { upsertNote } = await import('./helpers/owned-storage.js');
    upsertNote({
      path: 'temp-ignore.md',
      title: 'Ignore me',
      tags: [],
      content: '',
      mtime: 1,
      hash: 'hash1',
      chunks: [],
    });

    const { getDb } = await import('./helpers/owned-storage.js');
    const db = getDb();
    const allNotes = db.prepare('SELECT path FROM notes').all() as { path: string }[];
    assert.equal(allNotes.length, 1);

    // Store empty patterns first so a change is detected later
    const { cleanupIgnoredNotes } = await import('./helpers/owned-storage.js');
    cleanupIgnoredNotes([]);

    process.env.OBSIDIAN_IGNORE_PATTERNS = 'temp-ignore.md';
    const { cleanupStaleNotes } = await import('./helpers/owned-indexer');
    cleanupStaleNotes();

    const after = db.prepare('SELECT path FROM notes').all() as { path: string }[];
    assert.equal(after.length, 0, 'note should be removed after cleanup');

    delete process.env.OBSIDIAN_IGNORE_PATTERNS;
  });

  it('startWatcher calls chokidar.watch', async () => {
    const chokidar = await import('chokidar');
    const { startWatcher } = await import('./helpers/owned-indexer');
    startWatcher(4);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal((chokidar.watch as ReturnType<typeof vi.fn>).mock.calls.length, 1);
  });

  it('startWatcher does not ignore .gitignore files', async () => {
    const chokidar = await import('chokidar');
    const { startWatcher } = await import('./helpers/owned-indexer');
    startWatcher(4);
    await new Promise((r) => setTimeout(r, 10));

    const lastCall = (chokidar.watch as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    const options = lastCall?.[1] as { ignored?: (filePath: string) => boolean } | undefined;
    assert.equal(options?.ignored?.(path.join(vaultDir, '.gitignore')), false);
  });
});

describe('indexFile model integrity', () => {
  for (const mode of ['vector', 'null', 'frontmatter'] as const) {
    it(`preserves a rejected ${mode} update and retries normally after model restoration`, async () => {
      wipeDatabaseFiles();
      openDb();
      initVecTable(4);
      const modelSpy = vi.spyOn(embedder, 'activeModelName').mockReturnValue('model-A');
      const fullPath = path.join(vaultDir, 'integrity-retry.md');
      const detailed = vi.mocked(embedder.embedDetailed);
      const successful = (texts: string[]) =>
        Promise.resolve(
          texts.map(() => ({ ok: true as const, embedding: new Float32Array([1, 0, 0, 0]) })),
        );
      detailed.mockImplementation(successful);
      try {
        writeFileSync(
          fullPath,
          '# Original\n\nOriginal body with enough content to index successfully.',
        );
        utimesSync(fullPath, 1000, 1000);
        assert.equal(await indexFile(fullPath, 512), 'indexed');
        const before = getNoteByPath('integrity-retry.md');
        modelSpy.mockReturnValue('model-B');
        writeFileSync(
          fullPath,
          mode === 'frontmatter'
            ? '---\ntitle: Replacement\n---\n'
            : '# Replacement\n\nReplacement body waiting for corrected configuration.',
        );
        utimesSync(fullPath, 2000, 2000);
        if (mode === 'null')
          detailed.mockImplementation((texts) =>
            Promise.resolve(
              texts.map(() => ({
                ok: false as const,
                kind: 'invalid_response' as const,
                message: 'provider failed',
              })),
            ),
          );
        const rejected = await indexFile(fullPath, 512);
        assert.equal(typeof rejected, 'object');
        assert.ok(typeof rejected === 'object');
        assert.equal(isLikelyDatabaseCorruption(rejected.error), false);
        assert.deepEqual(getNoteByPath('integrity-retry.md'), before);
        modelSpy.mockReturnValue('model-A');
        assert.equal(await indexFile(fullPath, 512), 'indexed');
        assert.equal(await indexFile(fullPath, 512), 'skipped');
      } finally {
        modelSpy.mockRestore();
        detailed.mockImplementation(successful);
      }
    });
  }

  it('checks the captured producer against a marker changed during inference', async () => {
    wipeDatabaseFiles();
    openDb();
    initVecTable(4);
    const modelSpy = vi.spyOn(embedder, 'activeModelName').mockReturnValue('model-A');
    const fullPath = path.join(vaultDir, 'integrity-race.md');
    writeFileSync(fullPath, 'A new note with enough text for embedding.');
    vi.mocked(embedder.embedDetailed).mockImplementationOnce((texts) => {
      getDb()
        .prepare(
          "INSERT OR REPLACE INTO settings (key, value) VALUES ('embedding_model', 'model-B')",
        )
        .run();
      modelSpy.mockReturnValue('model-B');
      return Promise.resolve(
        texts.map(() => ({ ok: true as const, embedding: new Float32Array([1, 0, 0, 0]) })),
      );
    });
    try {
      const result = await indexFile(fullPath, 512);
      assert.equal(typeof result, 'object');
      assert.equal(getNoteByPath('integrity-race.md'), undefined);
    } finally {
      modelSpy.mockRestore();
    }
  });
});

describe('typed SQLite recovery', () => {
  const oldFreshness = '2000-01-01T00:00:00.000Z';
  const targetPath = 'recovery-target.md';
  const siblingPath = 'completed-sibling.md';
  const referencePath = 'retained-reference.md';
  let recoveryVault: string;
  let previousVault: string | undefined;

  function snapshotSibling() {
    const note = getNoteByPath(siblingPath);
    assert.ok(note, 'the clean sibling must already have committed');
    const db = getDb();
    const references = ['links', 'markdown_links', 'note_urls'].map((table) =>
      db.prepare(`SELECT * FROM ${table} WHERE from_path=? ORDER BY rowid`).all(siblingPath),
    );
    const expectedLink = [{ from_path: siblingPath, to_path: referencePath }];
    assert.deepEqual(references[0], expectedLink, 'the sibling must retain its wiki link');
    assert.deepEqual(references[1], expectedLink, 'the sibling must retain its Markdown link');
    return {
      note,
      chunks: db
        .prepare(
          'SELECT c.*, hex(v.embedding) AS vector FROM chunks c ' +
            'JOIN vec_chunks v ON v.chunk_id=c.id WHERE c.note_id=? ORDER BY c.id',
        )
        .all(note.id),
      metadata: ['note_aliases', 'note_tags', 'note_frontmatter_fields'].map((table) =>
        db.prepare(`SELECT * FROM ${table} WHERE note_id=? ORDER BY rowid`).all(note.id),
      ),
      references,
      fts: db
        .prepare("SELECT rowid FROM notes_fts_bm25 WHERE notes_fts_bm25 MATCH 'siblingneedle'")
        .all(),
    };
  }

  function freshness(): string | undefined {
    return getDb().prepare("SELECT value FROM settings WHERE key='last_indexed'").pluck().get() as
      string | undefined;
  }

  beforeEach(async () => {
    closeDb();
    previousVault = process.env.OBSIDIAN_VAULT_PATH;
    recoveryVault = mkdtempSync(path.join(tmpdir(), 'ohs-storage-recovery-'));
    process.env.OBSIDIAN_VAULT_PATH = recoveryVault;
    openDb();
    initVecTable(4);
    resetIndexingState();
    getDb().prepare("INSERT INTO settings(key,value) VALUES('last_indexed', ?)").run(oldFreshness);
    writeFileSync(path.join(recoveryVault, referencePath), 'A retained relation destination.');
    assert.equal(await indexFile(path.join(recoveryVault, referencePath), 512), 'indexed');
    writeFileSync(path.join(recoveryVault, targetPath), 'Target recoveryneedle body.');
    writeFileSync(
      path.join(recoveryVault, siblingPath),
      '---\ntitle: Completed sibling\ntags: [kept]\naliases: [Retained]\nstate: active\n---\n' +
        'siblingneedle [[retained-reference]] [target](retained-reference.md) ' +
        '[source](https://example.com/recovery)',
    );
    vi.mocked(embedder.embedDetailed).mockClear();
  });

  afterEach(() => {
    closeDb();
    resetIndexingState();
    if (previousVault === undefined) delete process.env.OBSIDIAN_VAULT_PATH;
    else process.env.OBSIDIAN_VAULT_PATH = previousVault;
    rmSync(recoveryVault, { recursive: true, force: true });
  });

  it.each(['single file', 'background', 'full vault'])(
    'uses default SQLite recovery for %s indexing and preserves the completed sibling',
    async (mode) => {
      let completedSibling: ReturnType<typeof snapshotSibling> | undefined;
      if (mode === 'single file') {
        assert.equal(await indexFile(path.join(recoveryVault, siblingPath), 512), 'indexed');
        completedSibling = snapshotSibling();
        vi.mocked(embedder.embedDetailed).mockClear();
      }
      const storage = await import('../src/storage/db.js');
      const actualCommit = storage.commitIndexedNote;
      const actualReopen = storage.reopenDatabaseForRecovery;
      const attempts = new Map<string, number>();
      const commit = vi.spyOn(storage, 'commitIndexedNote').mockImplementation((...args) => {
        const notePath = args[1].path;
        const count = (attempts.get(notePath) ?? 0) + 1;
        attempts.set(notePath, count);
        if (notePath === targetPath && count === 1)
          throw new storage.IndexStorageError(new Error('database disk image is malformed'));
        const result = actualCommit(...args);
        if (notePath === siblingPath) completedSibling ??= snapshotSibling();
        return result;
      });
      const reopen = vi.spyOn(storage, 'reopenDatabaseForRecovery').mockImplementation((lease) => {
        assert.ok(completedSibling, 'the clean sibling must commit before recovery starts');
        const previousConnection = getDb();
        actualReopen(lease);
        assert.equal(previousConnection.open, false);
        assert.notEqual(getDb(), previousConnection);
        assert.deepEqual(snapshotSibling(), completedSibling);
      });
      try {
        if (mode === 'single file')
          assert.equal(
            await indexFileWithRecovery(path.join(recoveryVault, targetPath), 512),
            'indexed',
          );
        else if (mode === 'background') await startBackgroundIndexing(512);
        else assert.deepEqual((await indexVaultSync(false)).errors, []);

        assert.equal(reopen.mock.calls.length, 1, 'recovery must reopen SQLite exactly once');
        assert.equal(attempts.get(targetPath), 2, 'only the failed commit needs a retry');
        assert.equal(attempts.get(siblingPath) ?? 0, mode === 'single file' ? 0 : 1);
        const inputs = vi.mocked(embedder.embedDetailed).mock.calls.flatMap(([texts]) => texts);
        assert.equal(inputs.filter((text) => text.includes('recoveryneedle')).length, 2);
        assert.equal(
          inputs.filter((text) => text.includes('siblingneedle')).length,
          mode === 'single file' ? 0 : 1,
          'a completed sibling must not be re-embedded after reopening',
        );
        assert.deepEqual(snapshotSibling(), completedSibling);
        assert.ok(completedSibling && completedSibling.chunks.length > 0);
        assert.equal(completedSibling.fts.length, 1);
        assert.equal(getNoteByPath(targetPath)?.content, 'Target recoveryneedle body.');
        assert.equal(
          getDb()
            .prepare(
              'SELECT count(*) FROM chunks c JOIN notes n ON n.id=c.note_id ' +
                "JOIN vec_chunks v ON v.chunk_id=c.id WHERE n.path=? AND c.embedding_status='ok'",
            )
            .pluck()
            .get(targetPath),
          1,
          'the retried note must have its accepted vector',
        );
        assert.equal(
          getDb()
            .prepare('SELECT count(*) FROM index_failures WHERE path=?')
            .pluck()
            .get(targetPath),
          0,
        );
        if (mode === 'single file') assert.equal(freshness(), oldFreshness);
        else {
          const updated = freshness();
          assert.ok(updated && Date.parse(updated) > Date.parse(oldFreshness));
        }
      } finally {
        reopen.mockRestore();
        commit.mockRestore();
      }
    },
  );

  it.each([undefined, oldFreshness])(
    'stops after repeated storage failure and preserves freshness %s',
    async (savedFreshness) => {
      if (savedFreshness === undefined)
        getDb().prepare("DELETE FROM settings WHERE key='last_indexed'").run();
      const storage = await import('../src/storage/db.js');
      const actual = storage.commitIndexedNote;
      let completedSibling: ReturnType<typeof snapshotSibling> | undefined;
      let targetAttempts = 0;
      const commit = vi.spyOn(storage, 'commitIndexedNote').mockImplementation((...args) => {
        if (args[1].path === targetPath) {
          targetAttempts++;
          throw new storage.IndexStorageError(new Error('database disk image is malformed'));
        }
        const result = actual(...args);
        if (args[1].path === siblingPath) completedSibling ??= snapshotSibling();
        return result;
      });
      const reopen = vi.spyOn(storage, 'reopenDatabaseForRecovery');
      try {
        await assert.rejects(indexVaultSync(false), /malformed/);
        assert.equal(reopen.mock.calls.length, 1);
        assert.equal(targetAttempts, 2, 'persistent corruption must stop after one retry');
        assert.equal(getNoteByPath(targetPath), undefined);
        assert.ok(completedSibling && completedSibling.chunks.length > 0);
        assert.deepEqual(snapshotSibling(), completedSibling);
        assert.equal(freshness(), savedFreshness);
      } finally {
        reopen.mockRestore();
        commit.mockRestore();
      }
    },
  );
});
