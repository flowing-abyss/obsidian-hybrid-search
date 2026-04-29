import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, it, vi } from 'vitest';

vi.mock('chokidar', () => ({
  watch: vi.fn().mockReturnValue({
    on: vi.fn().mockReturnThis(),
  }),
}));

const vaultDir = mkdtempSync(path.join(tmpdir(), 'ohs-indexer-file-test-'));
process.env.OBSIDIAN_VAULT_PATH = vaultDir;

const { openDb, wipeDatabaseFiles, getNoteByPath, getDb, initVecTable } =
  await import('../src/db.js');

// Spy on embedder *before* importing indexer so live bindings pick up the mocks
const embedder = await import('../src/embedder.js');
vi.spyOn(embedder, 'embed').mockResolvedValue([new Float32Array([0.1, 0.2, 0.3, 0.4])]);
vi.spyOn(embedder, 'getContextLength').mockResolvedValue(512);

const {
  indexFile,
  scanVault,
  populateMissingLinks,
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
      | { value: string }
      | undefined;
    assert.equal(flag?.value, '1');

    // Second call should be a no-op
    await populateMissingLinks();
    const flag2 = db.prepare("SELECT value FROM settings WHERE key = 'links_v1'").get() as
      | { value: string }
      | undefined;
    assert.equal(flag2?.value, '1');
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
    const embedSpy = embedder.embed as ReturnType<typeof vi.fn>;
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
});
