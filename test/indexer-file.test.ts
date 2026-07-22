import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, it, vi } from 'vitest';

vi.mock('chokidar', () => ({
  watch: vi.fn().mockReturnValue({
    add: vi.fn().mockReturnThis(),
    on: vi.fn().mockReturnThis(),
  }),
}));

const vaultDir = mkdtempSync(path.join(tmpdir(), 'ohs-indexer-file-test-'));
process.env.OBSIDIAN_VAULT_PATH = vaultDir;

const { closeDb, openDb, wipeDatabaseFiles, getNoteByPath, getDb, initVecTable } =
  await import('../src/db.js');

// Spy on embedder *before* importing indexer so live bindings pick up the mocks
const embedder = await import('../src/embedder.js');
vi.spyOn(embedder, 'embed').mockResolvedValue([new Float32Array([0.1, 0.2, 0.3, 0.4])]);
vi.spyOn(embedder, 'embedDetailed').mockImplementation(async (texts: string[]) =>
  texts.map(() => ({
    ok: true as const,
    embedding: new Float32Array([0.1, 0.2, 0.3, 0.4]),
  })),
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
    detailedSpy.mockImplementation(async (texts: string[]) =>
      texts.map((text) =>
        Array.from(text).length <= 36
          ? { ok: true as const, embedding: new Float32Array([0.1, 0.2, 0.3, 0.4]) }
          : { ok: false as const, kind: 'input_too_long', status: 400, message: 'too long' },
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
      detailedSpy.mockImplementation(async (texts: string[]) =>
        texts.map(() => ({
          ok: true as const,
          embedding: new Float32Array([0.1, 0.2, 0.3, 0.4]),
        })),
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
} = await import('../src/indexer.js');

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
    scanVault().files.map((file) => path.relative(vaultDir, file).split(path.sep).join('/'));

  it('finds markdown files in the vault', () => {
    writeFileSync(path.join(vaultDir, 'found.md'), '# Found');
    const { files } = scanVault();
    assert.ok(files.some((f) => f.endsWith('found.md')));
  });

  it('ignores non-markdown files', () => {
    writeFileSync(path.join(vaultDir, 'readme.txt'), 'text');
    const { files } = scanVault();
    assert.ok(!files.some((f) => f.endsWith('readme.txt')));
  });

  it('recurses into subdirectories', () => {
    mkdirSync(path.join(vaultDir, 'sub'), { recursive: true });
    writeFileSync(path.join(vaultDir, 'sub', 'nested.md'), '# Nested');
    const { files } = scanVault();
    assert.ok(files.some((f) => f.endsWith('nested.md')));
  });

  it('skips ignored directories', () => {
    mkdirSync(path.join(vaultDir, 'templates'), { recursive: true });
    writeFileSync(path.join(vaultDir, 'templates', 't.md'), '# T');
    const { files } = scanVault();
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
      const { files } = scanVault();

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

  it('auto-recovers and indexes a single file after database sidecar corruption', async () => {
    const filePath = path.join(vaultDir, 'single-file-corrupt-recovery.md');
    writeFileSync(filePath, '# Single File Corrupt Recovery\n\nRecovered marker.');

    wipeDatabaseFiles();
    openDb();
    initVecTable(4);

    const embedSpy = embedder.embedDetailed as ReturnType<typeof vi.fn>;
    embedSpy.mockRejectedValueOnce(new Error('database disk image is malformed'));
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let recoveries = 0;

    const result = await indexFileWithRecovery(filePath, 512, false, () => {
      recoveries++;
      openDb();
      initVecTable(4);
    });

    assert.equal(result, 'indexed');
    assert.equal(recoveries, 1);
    assert.ok(getNoteByPath('single-file-corrupt-recovery.md'));
    assert.ok(
      stderrSpy.mock.calls.some((c) => c[0]?.toString().includes('[auto-heal]')),
      'expected single-file indexing to run auto-heal',
    );

    stderrSpy.mockRestore();
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

  it('logs background indexing errors', async () => {
    writeFileSync(path.join(vaultDir, 'bg-error.md'), '# BG Error');

    wipeDatabaseFiles();
    openDb();
    initVecTable(4);
    resetIndexingState();

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      if (typeof chunk === 'string' && chunk.includes('Indexing vault')) {
        throw new Error('stderr broken');
      }
      return true;
    });

    await startBackgroundIndexing(512);

    // Wait for async error handling
    await new Promise((r) => setTimeout(r, 100));

    assert.ok(
      warnSpy.mock.calls.some((c) => String(c[0]).includes('background indexing error')),
      'expected console.warn to be called with error message',
    );

    warnSpy.mockRestore();
    stderrSpy.mockRestore();
    resetIndexingState();
  });

  it('auto-recovers database sidecar corruption during background indexing', async () => {
    writeFileSync(path.join(vaultDir, 'bg-corrupt-recovery.md'), '# BG Corrupt Recovery');

    wipeDatabaseFiles();
    openDb();
    initVecTable(4);
    resetIndexingState();

    const embedSpy = embedder.embedDetailed as ReturnType<typeof vi.fn>;
    embedSpy.mockRejectedValueOnce(new Error('database disk image is malformed'));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await startBackgroundIndexing(512);
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        const status = getIndexingStatus();
        if (!status.isRunning) {
          clearInterval(interval);
          resolve();
        }
      }, 50);
    });

    assert.ok(
      stderrSpy.mock.calls.some((c) => c[0]?.toString().includes('[auto-heal]')),
      'expected background indexing to run auto-heal',
    );
    assert.ok(
      !warnSpy.mock.calls.some((c) => String(c[0]).includes('background indexing error')),
      'expected background indexing to recover without surfacing a background error',
    );
    assert.ok(getNoteByPath('bg-corrupt-recovery.md'));

    warnSpy.mockRestore();
    stderrSpy.mockRestore();
    resetIndexingState();
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

  it('aborts before marking the index fresh when a file fails with database corruption', async () => {
    const filePath = path.join(vaultDir, 'corrupt-db-error.md');
    writeFileSync(filePath, '# Corrupt DB Error\\n\\nSome content here.', 'utf-8');

    wipeDatabaseFiles();
    openDb();
    initVecTable(4);
    resetIndexingState();

    const embedSpy = embedder.embedDetailed as ReturnType<typeof vi.fn>;
    embedSpy.mockRejectedValueOnce(new Error('database disk image is malformed'));

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await assert.rejects(
      () => indexVaultSync(false, 'Test indexing...'),
      /database disk image is malformed/,
    );

    const lastIndexed = getDb()
      .prepare("SELECT value FROM settings WHERE key = 'last_indexed'")
      .get() as { value: string } | undefined;
    assert.equal(lastIndexed, undefined);

    stderrSpy.mockRestore();
  });

  it('recovers sidecars and retries only the affected batch during full-vault indexing', async () => {
    const filePath = path.join(vaultDir, 'recover-corrupt-file.md');
    const cleanPath = path.join(vaultDir, 'recover-clean-control.md');
    writeFileSync(filePath, '# Recover Corrupt File\n\nNeeds Recovery marker.', 'utf-8');
    writeFileSync(cleanPath, '# Recover Clean Control\n\nClean Control marker.', 'utf-8');

    wipeDatabaseFiles();
    openDb();
    initVecTable(4);
    resetIndexingState();

    const embedSpy = embedder.embedDetailed as ReturnType<typeof vi.fn>;
    const embeddedTexts: string[] = [];
    let hasThrownMalformed = false;
    embedSpy.mockImplementation((texts: string[]) => {
      const joined = texts.join('\n');
      embeddedTexts.push(joined);
      if (joined.includes('Needs Recovery marker') && !hasThrownMalformed) {
        hasThrownMalformed = true;
        throw new Error('database disk image is malformed');
      }
      return texts.map(() => ({
        ok: true as const,
        embedding: new Float32Array([0.1, 0.2, 0.3, 0.4]),
      }));
    });
    let recoveries = 0;

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      const result = await indexVaultSync(false, 'Test indexing...', {
        recoverDatabase: () => {
          recoveries++;
          openDb();
          initVecTable(4);
        },
      });

      assert.equal(recoveries, 1);
      assert.equal(result.errors.length, 0);
      assert.ok(getNoteByPath('recover-corrupt-file.md'));
      assert.ok(getNoteByPath('recover-clean-control.md'));
      assert.equal(
        embeddedTexts.filter((text) => text.includes('Needs Recovery marker')).length,
        2,
        'corruption-failed file should be retried once',
      );
      assert.equal(
        embeddedTexts.filter((text) => text.includes('Clean Control marker')).length,
        2,
        'other files in the affected batch are retried to restore any WAL-backed writes',
      );
      const lastIndexed = getDb()
        .prepare("SELECT value FROM settings WHERE key = 'last_indexed'")
        .get() as { value: string } | undefined;
      assert.ok(lastIndexed);
    } finally {
      embedSpy.mockReset();
      embedSpy.mockImplementation((texts: string[]) =>
        texts.map(() => ({
          ok: true as const,
          embedding: new Float32Array([0.1, 0.2, 0.3, 0.4]),
        })),
      );
      stderrSpy.mockRestore();
    }
  });

  it('does not mark the index fresh when corruption repeats after recovery', async () => {
    const filePath = path.join(vaultDir, 'repeat-corrupt-file.md');
    writeFileSync(filePath, '# Repeat Corrupt File\n\nRepeats malformed marker.', 'utf-8');

    wipeDatabaseFiles();
    openDb();
    initVecTable(4);
    resetIndexingState();

    const embedSpy = embedder.embedDetailed as ReturnType<typeof vi.fn>;
    embedSpy.mockImplementation((texts: string[]) => {
      if (texts.join('\n').includes('Repeats malformed marker')) {
        throw new Error('database disk image is malformed');
      }
      return texts.map(() => ({
        ok: true as const,
        embedding: new Float32Array([0.1, 0.2, 0.3, 0.4]),
      }));
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let recoveries = 0;

    try {
      await assert.rejects(
        () =>
          indexVaultSync(false, 'Test indexing...', {
            recoverDatabase: () => {
              recoveries++;
              openDb();
              initVecTable(4);
            },
          }),
        /database disk image is malformed/,
      );

      assert.equal(recoveries, 1);
      const lastIndexed = getDb()
        .prepare("SELECT value FROM settings WHERE key = 'last_indexed'")
        .get() as { value: string } | undefined;
      assert.equal(lastIndexed, undefined);
    } finally {
      embedSpy.mockReset();
      embedSpy.mockImplementation((texts: string[]) =>
        texts.map(() => ({
          ok: true as const,
          embedding: new Float32Array([0.1, 0.2, 0.3, 0.4]),
        })),
      );
      stderrSpy.mockRestore();
    }
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

    const { upsertNote } = await import('../src/db');
    upsertNote({
      path: 'temp-ignore.md',
      title: 'Ignore me',
      tags: [],
      content: '',
      mtime: 1,
      hash: 'hash1',
      chunks: [],
    });

    const { getDb } = await import('../src/db');
    const db = getDb();
    const allNotes = db.prepare('SELECT path FROM notes').all() as { path: string }[];
    assert.equal(allNotes.length, 1);

    // Store empty patterns first so a change is detected later
    const { getPathsToRemoveForIgnoreChange } = await import('../src/db');
    getPathsToRemoveForIgnoreChange([]);

    process.env.OBSIDIAN_IGNORE_PATTERNS = 'temp-ignore.md';
    const { cleanupStaleNotes } = await import('../src/indexer');
    cleanupStaleNotes();

    const after = db.prepare('SELECT path FROM notes').all() as { path: string }[];
    assert.equal(after.length, 0, 'note should be removed after cleanup');

    delete process.env.OBSIDIAN_IGNORE_PATTERNS;
  });

  it('startWatcher calls chokidar.watch', async () => {
    const chokidar = await import('chokidar');
    const { startWatcher } = await import('../src/indexer');
    startWatcher(4);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal((chokidar.watch as ReturnType<typeof vi.fn>).mock.calls.length, 1);
  });

  it('startWatcher does not ignore .gitignore files', async () => {
    const chokidar = await import('chokidar');
    const { startWatcher } = await import('../src/indexer');
    startWatcher(4);
    await new Promise((r) => setTimeout(r, 10));

    const lastCall = (chokidar.watch as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    const options = lastCall?.[1] as { ignored?: (filePath: string) => boolean } | undefined;
    assert.equal(options?.ignored?.(path.join(vaultDir, '.gitignore')), false);
  });
});
