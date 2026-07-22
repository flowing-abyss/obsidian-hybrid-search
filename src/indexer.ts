import matter from 'gray-matter';
import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  createDocumentTextProjector,
  embedChunksWithRecovery,
  type EmbeddedChunk,
} from './chunk-embedding.js';
import { chunkNote, createChunkBoundaryIndex, refineChunksToFit } from './chunker.js';
import { config } from './config.js';
import {
  deleteNote,
  getDb,
  getNoteMeta,
  getPathsToRemoveForIgnoreChange,
  getStoredEmbeddingDim,
  initVecTable,
  isLikelyDatabaseCorruption,
  openDb,
  updateLastIndexed,
  upsertLinks,
  upsertMarkdownLinks,
  upsertNote,
  upsertNoteUrls,
  wipeDatabaseSidecars,
} from './db.js';
import { embedDetailed, getContextLength, getDocumentTokenPolicy } from './embedder.js';
import { createIgnorePolicy, type IgnorePolicy } from './ignore.js';
import { extractMarkdownReferences, resolveMarkdownNoteLinks } from './markdown-references.js';
import { bumpIndexVersion } from './searcher.js';

export interface IndexResult {
  indexed: number;
  skipped: number;
  errors: Array<{ path: string; error: string }>;
}

function findDatabaseCorruptionError(
  errors: ReadonlyArray<{ path: string; error: string }>,
): { path: string; error: string } | undefined {
  return errors.find((error) => isLikelyDatabaseCorruption(error.error));
}

function recoverDatabaseSidecarsForIndexing(): void {
  wipeDatabaseSidecars();
  openDb();
  const embeddingDim = getStoredEmbeddingDim();
  if (embeddingDim !== null) {
    initVecTable(embeddingDim);
  }
}

async function runWithDatabaseRecovery<T>(
  label: string,
  operation: () => T | Promise<T>,
  recoverDatabase: (() => void) | undefined,
): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    if (!recoverDatabase || !isLikelyDatabaseCorruption(err)) throw err;
    process.stderr.write(
      `[auto-heal] SQLite index corruption detected during ${label}; removing WAL/SHM sidecars and retrying once.\n`,
    );
    recoverDatabase();
    return operation();
  }
}

async function indexBatch(
  files: readonly string[],
  contextLength: number,
  force: boolean,
): Promise<IndexResult> {
  const result: IndexResult = { indexed: 0, skipped: 0, errors: [] };
  const policy = createIgnorePolicy();
  await Promise.all(
    files.map(async (f) => {
      const status = await indexFile(f, contextLength, force, policy);
      if (status === 'indexed') result.indexed++;
      else if (status === 'skipped') result.skipped++;
      else {
        result.errors.push({
          path: f,
          error: typeof status === 'object' ? status.error : 'indexing failed',
        });
      }
    }),
  );
  return result;
}

async function indexBatchWithRecovery(
  batch: readonly string[],
  contextLength: number,
  force: boolean,
  recoverDatabase: (() => void) | undefined,
): Promise<IndexResult> {
  const batchResult = await indexBatch(batch, contextLength, force);
  const corruption = findDatabaseCorruptionError(batchResult.errors);
  if (!corruption) return batchResult;

  if (!recoverDatabase) {
    throw new Error(`${corruption.path}: ${corruption.error}`);
  }

  process.stderr.write(
    `[auto-heal] SQLite index corruption detected; removing WAL/SHM sidecars and retrying ${batch.length} file${batch.length > 1 ? 's' : ''} from the affected batch.\n`,
  );
  recoverDatabase();

  const retryResult = await indexBatch(batch, contextLength, true);
  const retryCorruption = findDatabaseCorruptionError(retryResult.errors);
  if (retryCorruption) {
    throw new Error(`${retryCorruption.path}: ${retryCorruption.error}`);
  }

  return retryResult;
}

export async function withIndexingDbLock<T>(operation: () => T | Promise<T>): Promise<T> {
  const run = _indexingDbLock.then(
    () => Promise.resolve(operation()),
    () => Promise.resolve(operation()),
  );
  _indexingDbLock = run.then(
    () => {},
    () => {},
  );
  return run;
}

function toVaultRelativePath(fullPath: string): string {
  return path.relative(config.vaultPath, fullPath).split(path.sep).join('/').normalize('NFD');
}

function getExistingNotePathSet(): Set<string> {
  const rows = getDb().prepare('SELECT path FROM notes').all() as { path: string }[];
  return new Set(rows.map((row) => row.path));
}

function resolveMarkdownReferencesForNote(
  fromPath: string,
  content: string,
  existingPaths = getExistingNotePathSet(),
): { links: string[]; urls: string[] } {
  const references = extractMarkdownReferences(content);
  const links = resolveMarkdownNoteLinks(
    fromPath,
    references.localDestinations.map((link) => link.destination),
    existingPaths,
  );
  return { links, urls: references.urls };
}

export interface ScanResult {
  files: string[];
  /** Directories whose readdir failed; non-empty means the scan is PARTIAL. */
  readErrors: string[];
}

function* walkDir(dir: string, policy: IgnorePolicy, readErrors: string[]): Generator<string> {
  let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[];
  try {
    entries = readdirSync(dir, {
      withFileTypes: true,
      encoding: 'utf-8',
    });
  } catch (err) {
    // A failed readdir (cloud FS hiccup) must NOT silently vanish a subtree:
    // downstream stale-note cleanup would interpret it as mass deletion.
    readErrors.push(dir);
    console.warn(
      `[scan] readdir failed for ${dir}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const rel = toVaultRelativePath(full);
      if (!policy.isIgnored(rel + '/')) {
        yield* walkDir(full, policy, readErrors);
      }
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      yield full;
    }
  }
}

export function scanVault(): ScanResult {
  const files: string[] = [];
  const readErrors: string[] = [];
  const policy = createIgnorePolicy();
  for (const fullPath of walkDir(config.vaultPath, policy, readErrors)) {
    const rel = toVaultRelativePath(fullPath);
    if (!policy.isIgnored(rel)) {
      files.push(fullPath);
    }
  }
  return { files, readErrors };
}

export async function indexFile(
  fullPath: string,
  contextLength?: number,
  force = false,
  policy = createIgnorePolicy(),
): Promise<'indexed' | 'skipped' | { error: string }> {
  try {
    const stat = statSync(fullPath);
    const mtime = stat.mtimeMs;

    const relPath = toVaultRelativePath(fullPath);
    if (policy.isIgnored(relPath)) return 'skipped';
    const existing = force ? undefined : getNoteMeta(relPath);

    // Fast skip: mtime unchanged
    if (existing && existing.mtime === mtime) return 'skipped';

    const raw = await readFile(fullPath, 'utf-8');
    const hash = createHash('md5').update(raw).digest('hex');

    // Slow skip: content unchanged, only update mtime
    if (existing && existing.hash === hash) {
      getDb().prepare('UPDATE notes SET mtime = ? WHERE path = ?').run(mtime, relPath);
      return 'skipped';
    }

    const parsed = matter(raw);
    const { data: frontmatter, content } = parsed;
    const frontmatterRaw: string = parsed.matter;
    const title =
      frontmatter.title == null ? path.basename(fullPath, '.md') : String(frontmatter.title);
    const frontmatterTags: string[] = Array.isArray(frontmatter.tags)
      ? frontmatter.tags.map(String)
      : typeof frontmatter.tags === 'string'
        ? frontmatter.tags.split(',').map((t: string) => t.trim())
        : [];
    const inlineTags = parseInlineTags(content);
    const tags = [...new Set([...frontmatterTags, ...inlineTags])];
    const aliases = parseAliasField(frontmatter.aliases as unknown);

    const ctxLen = contextLength ?? (await getContextLength());
    const semanticChunks = chunkNote(content, ctxLen).filter((c) => c.text.trim().length > 0);
    let embeddedChunks: EmbeddedChunk[] = [];
    // Notes with no body content (only frontmatter) still get indexed so that
    // tag/frontmatter filters and title search can find them.
    if (semanticChunks.length > 0) {
      const tokenPolicy = await getDocumentTokenPolicy();
      const boundaryIndex = createChunkBoundaryIndex(content);
      const project = createDocumentTextProjector(title, tokenPolicy);
      const chunks = refineChunksToFit(
        content,
        semanticChunks,
        tokenPolicy.limit,
        (body, headingChain) => tokenPolicy.count(project(body, headingChain)),
        config.chunkOverlap,
        boundaryIndex,
      );
      embeddedChunks = await embedChunksWithRecovery({
        source: content,
        chunks,
        boundaryIndex,
        project,
        embed: (texts) => embedDetailed(texts, 'document'),
      });
    }

    upsertNote({
      path: relPath,
      title,
      tags,
      aliases,
      content,
      frontmatter: frontmatter,
      mtime: stat.mtimeMs,
      hash,
      chunks: embeddedChunks.map(({ chunk, embedding }) => ({
        text: chunk.text,
        headingPath: chunk.headingChain.length > 0 ? chunk.headingChain.join(' > ') : null,
        embedding,
        charStart: chunk.charStart,
        charEnd: chunk.charEnd,
      })),
    });

    const resolvedLinks = resolveWikilinks(frontmatterRaw + '\n' + content, relPath);
    upsertLinks(relPath, resolvedLinks);
    const markdownReferences = resolveMarkdownReferencesForNote(relPath, content);
    upsertMarkdownLinks(relPath, markdownReferences.links);
    upsertNoteUrls(relPath, markdownReferences.urls);

    bumpIndexVersion();
    return 'indexed';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env.LOG_LEVEL === 'debug') {
      console.error('[indexer] error indexing', fullPath, err);
    }
    return { error: msg };
  }
}

export async function indexFileWithRecovery(
  fullPath: string,
  contextLength: number,
  force = false,
  recoverDatabase: () => void = recoverDatabaseSidecarsForIndexing,
): Promise<'indexed' | 'skipped' | { error: string }> {
  const policy = createIgnorePolicy();
  const status = await indexFile(fullPath, contextLength, force, policy);
  if (status === 'indexed' || status === 'skipped' || !isLikelyDatabaseCorruption(status.error)) {
    return status;
  }

  process.stderr.write(
    '[auto-heal] SQLite index corruption detected while indexing one file; removing WAL/SHM sidecars and retrying once.\n',
  );
  recoverDatabase();
  return indexFile(fullPath, contextLength, true, createIgnorePolicy());
}

/**
 * One-time migration: populate links from stored note content for all notes
 * that were indexed before the links feature was added. No API calls — just
 * wikilink parsing and DB writes.
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function populateMissingLinks(): Promise<void> {
  const db = getDb();
  const done = (
    db.prepare("SELECT value FROM settings WHERE key = 'links_v1'").get() as
      { value: string } | undefined
  )?.value;
  if (done) return;

  const notes = db
    .prepare('SELECT path, content, frontmatter FROM notes WHERE content IS NOT NULL')
    .all() as {
    path: string;
    content: string;
    frontmatter: string;
  }[];
  for (const note of notes) {
    const links = resolveWikilinks((note.frontmatter || '') + '\n' + note.content, note.path);
    upsertLinks(note.path, links);
  }

  db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES('links_v1', '1')").run();
}

/**
 * One-time migration: populate resolved Markdown file links and external URLs
 * from stored note content for all notes indexed before this feature existed.
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function populateMissingMarkdownReferences(): Promise<void> {
  const db = getDb();
  const done = (
    db.prepare("SELECT value FROM settings WHERE key = 'markdown_links_v1'").get() as
      { value: string } | undefined
  )?.value;
  if (done) return;

  const notes = db.prepare('SELECT path, content FROM notes WHERE content IS NOT NULL').all() as {
    path: string;
    content: string;
  }[];
  const existingPaths = new Set(notes.map((note) => note.path));
  const tx = db.transaction(() => {
    for (const note of notes) {
      const references = resolveMarkdownReferencesForNote(note.path, note.content, existingPaths);
      upsertMarkdownLinks(note.path, references.links);
      upsertNoteUrls(note.path, references.urls);
    }
    db.prepare(
      "INSERT OR REPLACE INTO settings(key, value) VALUES('markdown_links_v1', '1')",
    ).run();
    db.prepare(
      "INSERT OR REPLACE INTO settings(key, value) VALUES('db_version', CAST(COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'db_version'), 0) + 1 AS TEXT))",
    ).run();
  });
  tx();
}

/**
 * Re-resolve wikilinks for ALL indexed notes unconditionally.
 * Called after every full vault reindex so that notes whose targets
 * didn't exist at index time get their links backfilled.
 */
// eslint-disable-next-line @typescript-eslint/require-await
async function resolveAllLinks(): Promise<void> {
  const db = getDb();
  const notes = db
    .prepare('SELECT path, content, frontmatter FROM notes WHERE content IS NOT NULL')
    .all() as {
    path: string;
    content: string;
    frontmatter: string;
  }[];
  for (const note of notes) {
    const links = resolveWikilinks((note.frontmatter || '') + '\n' + note.content, note.path);
    upsertLinks(note.path, links);
  }
}

// eslint-disable-next-line @typescript-eslint/require-await
async function resolveAllMarkdownReferences(): Promise<void> {
  const db = getDb();
  const notes = db.prepare('SELECT path, content FROM notes WHERE content IS NOT NULL').all() as {
    path: string;
    content: string;
  }[];
  const existingPaths = new Set(notes.map((note) => note.path));
  for (const note of notes) {
    const references = resolveMarkdownReferencesForNote(note.path, note.content, existingPaths);
    upsertMarkdownLinks(note.path, references.links);
    upsertNoteUrls(note.path, references.urls);
  }
}

/**
 * Remove notes that no longer belong in the index:
 * - notes matching updated ignore patterns
 * - notes whose files were deleted from disk
 * Called on server startup and during full reindex.
 */
export function cleanupStaleNotes(fsPaths?: Set<string>): void {
  let deleted = 0;

  // Newly ignored notes: file still exists on disk, keep their link entries
  // so backlinks from ignored notes remain visible in search results
  const policy = createIgnorePolicy();
  const pathsToRemove = getPathsToRemoveForIgnoreChange(
    config.ignorePatterns,
    policy.signature(),
    (p) => policy.isIgnored(p),
  );
  for (const p of pathsToRemove) {
    if (policy.isIgnored(p)) {
      deleteNote(p, true); // keepLinks=true
      deleted++;
    }
  }

  // Notes deleted from filesystem: remove everything including links (broken links)
  if (fsPaths) {
    const db = getDb();
    const dbPaths = (db.prepare('SELECT path FROM notes').all() as { path: string }[]).map(
      (r) => r.path,
    );
    for (const dbPath of dbPaths) {
      if (!fsPaths.has(dbPath)) {
        deleteNote(dbPath); // keepLinks=false
        deleted++;
      }
    }
  }

  if (deleted > 0) bumpIndexVersion();
}

export function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

const PROGRESS_BAR_WIDTH = 20;
// Number of completed batches to wait before showing ETA (lets the rate stabilise)
const ETA_WARMUP_BATCHES = 3;

export function renderProgressLine(processed: number, total: number, etaStr: string): string {
  const pct = total > 0 ? processed / total : 1;
  const filled = Math.round(pct * PROGRESS_BAR_WIDTH);
  const bar = '█'.repeat(filled) + '░'.repeat(PROGRESS_BAR_WIDTH - filled);
  const pctLabel = `${Math.round(pct * 100)}%`.padStart(4);
  return `  ${bar}  ${pctLabel} (${processed}/${total} notes)${etaStr}`;
}

export async function indexVaultSync(
  force = false,
  header = 'Indexing vault...',
  options: { requireClean?: boolean; recoverDatabase?: () => void } = {},
): Promise<IndexResult> {
  const { files, readErrors } = scanVault();
  const scanComplete = readErrors.length === 0;
  const fsPaths = new Set(files.map(toVaultRelativePath));
  if (!scanComplete) {
    console.warn(
      `[scan] PARTIAL scan (${readErrors.length} unreadable dirs) - skipping stale-note cleanup`,
    );
  }
  await runWithDatabaseRecovery(
    'stale-note cleanup',
    () => cleanupStaleNotes(scanComplete ? fsPaths : undefined),
    options.recoverDatabase,
  );

  const contextLength = await getContextLength();
  const result: IndexResult = { indexed: 0, skipped: 0, errors: [] };

  if (files.length === 0) {
    await runWithDatabaseRecovery(
      'link resolution',
      () => resolveAllLinks(),
      options.recoverDatabase,
    );
    await runWithDatabaseRecovery(
      'markdown reference resolution',
      () => resolveAllMarkdownReferences(),
      options.recoverDatabase,
    );
    await runWithDatabaseRecovery(
      'freshness update',
      () => updateLastIndexed(),
      options.recoverDatabase,
    );
    return result;
  }

  const isTTY = process.stderr.isTTY === true;
  const logEvery = Math.max(config.batchSize, Math.floor(files.length / 10));

  process.stderr.write(`${header}\n`);
  if (isTTY) {
    // Print initial empty bar without newline — will be overwritten in-place
    process.stderr.write(renderProgressLine(0, files.length, ''));
  }
  const startTime = Date.now();

  for (let i = 0; i < files.length; i += config.batchSize) {
    const batch = files.slice(i, i + config.batchSize);
    const batchResult = await indexBatchWithRecovery(
      batch,
      contextLength,
      force,
      options.recoverDatabase,
    );
    result.indexed += batchResult.indexed;
    result.skipped += batchResult.skipped;
    result.errors.push(...batchResult.errors);

    const processed = Math.min(i + config.batchSize, files.length);
    const completedBatches = Math.floor(i / config.batchSize) + 1;
    const elapsedSec = (Date.now() - startTime) / 1000;
    const rate = elapsedSec > 0 ? processed / elapsedSec : 0;
    const remainingSec =
      completedBatches >= ETA_WARMUP_BATCHES && rate > 0 && processed < files.length
        ? (files.length - processed) / rate
        : 0;
    const etaStr = remainingSec > 5 ? ` — ${formatDuration(remainingSec)} remaining` : '';

    if (isTTY) {
      // \r\x1b[2K: return to line start and clear it, then redraw
      process.stderr.write(`\r\x1b[2K${renderProgressLine(processed, files.length, etaStr)}`);
    } else if (processed % logEvery < config.batchSize || processed >= files.length) {
      const pct = Math.round((processed / files.length) * 100);
      process.stderr.write(`${processed}/${files.length} (${pct}%)${etaStr}\n`);
    }
  }

  if (isTTY) {
    process.stderr.write('\n'); // finalise the progress bar line
  }
  const elapsed = formatDuration((Date.now() - startTime) / 1000);
  const summaryParts = [`${result.indexed} indexed`, `${result.skipped} skipped`];
  if (result.errors.length > 0) {
    summaryParts.push(`${result.errors.length} error${result.errors.length > 1 ? 's' : ''}`);
  }
  process.stderr.write(`Done in ${elapsed} — ${summaryParts.join(', ')}\n`);
  for (const e of result.errors) {
    process.stderr.write(`  ${e.path}: ${e.error}\n`);
  }
  if (options.requireClean === true && result.errors.length > 0) {
    throw new Error(
      `Full-vault reindex failed with ${result.errors.length} error${
        result.errors.length > 1 ? 's' : ''
      }; index freshness was not updated.`,
    );
  }

  await runWithDatabaseRecovery(
    'link resolution',
    () => resolveAllLinks(),
    options.recoverDatabase,
  );
  await runWithDatabaseRecovery(
    'markdown reference resolution',
    () => resolveAllMarkdownReferences(),
    options.recoverDatabase,
  );
  await runWithDatabaseRecovery(
    'freshness update',
    () => updateLastIndexed(),
    options.recoverDatabase,
  );
  return result;
}

const _indexQueue: string[] = [];
let _isIndexing = false;
let _totalExpected = 0;
let _processedCount = 0;
let _indexingDbLock: Promise<void> = Promise.resolve();

/** @internal Reset module-level queue state for test isolation. */
export function resetIndexingState(): void {
  _indexQueue.length = 0;
  _isIndexing = false;
  _totalExpected = 0;
  _processedCount = 0;
  _indexingDbLock = Promise.resolve();
}

/**
 * Returns the current background-indexing progress.
 * queued  — files still waiting in the queue (not yet processed)
 * total   — total files enqueued at the start of the current run
 * processed — files already processed in the current run
 * isRunning — whether a background indexing pass is active
 *
 * Used by the `status` tool/command to report correct `pending` counts
 * even before files have been written to the DB (S-19 fix).
 */
export function getIndexingStatus(): {
  queued: number;
  total: number;
  processed: number;
  isRunning: boolean;
} {
  return {
    queued: _indexQueue.length,
    total: _totalExpected,
    processed: _processedCount,
    isRunning: _isIndexing,
  };
}

async function processQueue(contextLength: number): Promise<void> {
  if (_isIndexing) return;
  await withIndexingDbLock(async () => {
    if (_isIndexing) return;
    _isIndexing = true;
    const total = _totalExpected;
    const startTime = Date.now();

    if (total > 0) {
      process.stderr.write(`Indexing vault...\n`);
    }

    try {
      const logEvery = Math.max(config.batchSize, Math.floor(total / 10));
      while (_indexQueue.length > 0) {
        const batch = _indexQueue.splice(0, config.batchSize);
        await indexBatchWithRecovery(
          batch,
          contextLength,
          false,
          recoverDatabaseSidecarsForIndexing,
        );
        _processedCount += batch.length;

        if (
          total > 0 &&
          (_processedCount % logEvery < config.batchSize || _indexQueue.length === 0)
        ) {
          const pct = Math.round((_processedCount / total) * 100);
          const elapsedSec = (Date.now() - startTime) / 1000;
          const rate = elapsedSec > 0 ? _processedCount / elapsedSec : 0;
          const remainingSec = rate > 0 && _indexQueue.length > 0 ? _indexQueue.length / rate : 0;
          const eta = remainingSec > 5 ? ` — ${formatDuration(remainingSec)} remaining` : '';
          process.stderr.write(`${_processedCount}/${total} (${pct}%)${eta}\n`);
        }
      }

      await runWithDatabaseRecovery(
        'background freshness update',
        () => updateLastIndexed(),
        recoverDatabaseSidecarsForIndexing,
      );

      if (total > 0) {
        const elapsed = formatDuration((Date.now() - startTime) / 1000);
        process.stderr.write(`Indexing complete in ${elapsed}\n`);
      }
    } finally {
      _isIndexing = false;
    }
  });
}

export async function startBackgroundIndexing(contextLength: number): Promise<void> {
  const { files, readErrors } = scanVault();
  const scanComplete = readErrors.length === 0;
  const fsPaths = new Set(files.map(toVaultRelativePath));
  if (!scanComplete) {
    console.warn(
      `[scan] PARTIAL scan (${readErrors.length} unreadable dirs) - skipping stale-note cleanup`,
    );
  }
  await withIndexingDbLock(() => {
    return runWithDatabaseRecovery(
      'background stale-note cleanup',
      () => cleanupStaleNotes(scanComplete ? fsPaths : undefined),
      recoverDatabaseSidecarsForIndexing,
    );
  });
  _totalExpected = files.length;
  _processedCount = 0;
  _indexQueue.push(...files);
  try {
    await processQueue(contextLength);
  } catch (err) {
    console.warn('[indexer] background indexing error:', err);
  }
}

const fileDelays = new Map<string, ReturnType<typeof setTimeout>>();
const pendingUnlinks = new Set<string>();

export function startWatcher(contextLength: number): void {
  import('chokidar')
    .then(({ watch }) => {
      let watcherPolicy = createIgnorePolicy();
      const watcher = watch(config.vaultPath, {
        ignored: (filePath: string) => {
          const base = path.basename(filePath);
          if (base === '.gitignore') return false;
          try {
            if (statSync(filePath).isDirectory()) {
              const rel = toVaultRelativePath(filePath);
              // chokidar v5 consults `ignored` for the watch root itself, where
              // rel is ''. isIgnored('/') throws → the catch below would fall
              // through to `return true`, marking the whole tree ignored and
              // silently disabling all file watching. Never ignore the vault root.
              if (rel === '') return false;
              return watcherPolicy.isIgnored(rel + '/');
            }
          } catch {
            // File doesn't exist — fall through to extension check below
          }
          if (!base.endsWith('.md')) return true;
          const rel = toVaultRelativePath(filePath);
          return watcherPolicy.isIgnored(rel);
        },
        persistent: true,
        ignoreInitial: true,
      });

      const handleFileChange = (filePath: string) => {
        const existing = fileDelays.get(filePath);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
          fileDelays.delete(filePath);
          const normalizedPath = path.normalize(filePath).normalize('NFD');
          if (!_indexQueue.includes(normalizedPath)) {
            _indexQueue.push(normalizedPath);
            _totalExpected++;
          }
          processQueue(contextLength).catch((err) => {
            console.warn('[watcher] queue processing error:', err);
          });
        }, config.debounce);
        fileDelays.set(filePath, timer);
      };

      const handleGitignoreChange = () => {
        void withIndexingDbLock(async () => {
          try {
            watcherPolicy = createIgnorePolicy();
            const { files, readErrors } = scanVault();
            const scanComplete = readErrors.length === 0;
            const fsPaths = new Set(files.map(toVaultRelativePath));
            if (!scanComplete) {
              console.warn(
                `[scan] PARTIAL scan (${readErrors.length} unreadable dirs) - skipping stale-note cleanup`,
              );
            }
            await runWithDatabaseRecovery(
              'watcher gitignore cleanup',
              () => cleanupStaleNotes(scanComplete ? fsPaths : undefined),
              recoverDatabaseSidecarsForIndexing,
            );
            for (const file of files) {
              const normalizedPath = path.normalize(file).normalize('NFD');
              if (!_indexQueue.includes(normalizedPath)) {
                _indexQueue.push(normalizedPath);
                _totalExpected++;
              }
            }
            watcher.add(config.vaultPath);
            void processQueue(contextLength).catch((err) => {
              console.warn('[watcher] queue processing error:', err);
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[watcher] gitignore change error: ${msg}`);
          }
        });
      };

      const safeHandleFileChange = (filePath: string) => {
        try {
          if (path.basename(filePath) === '.gitignore') {
            handleGitignoreChange();
            return;
          }
          handleFileChange(filePath);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[watcher] file change error for ${filePath}: ${msg}`);
        }
      };

      const safeHandleUnlink = (filePath: string) => {
        if (pendingUnlinks.has(filePath)) return;
        pendingUnlinks.add(filePath);
        void withIndexingDbLock(async () => {
          try {
            if (path.basename(filePath) === '.gitignore') {
              handleGitignoreChange();
              return;
            }
            const rel = toVaultRelativePath(filePath);
            const existing = fileDelays.get(filePath);
            if (existing) {
              clearTimeout(existing);
              fileDelays.delete(filePath);
            }
            await runWithDatabaseRecovery(
              'watcher unlink',
              () => {
                deleteNote(rel);
                bumpIndexVersion();
              },
              recoverDatabaseSidecarsForIndexing,
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[watcher] unlink error for ${filePath}: ${msg}`);
          } finally {
            pendingUnlinks.delete(filePath);
          }
        });
      };

      watcher.on('add', safeHandleFileChange);
      watcher.on('change', safeHandleFileChange);
      watcher.on('unlink', safeHandleUnlink);
    })
    .catch((err) => {
      console.warn('[watcher] chokidar load error:', err);
    });
}

/**
 * Extract inline tags from note body: #tag, #tag/subtag
 * Matches # preceded by start-of-string or whitespace, followed by
 * a letter/underscore and then any word chars, hyphens, or slashes.
 */
/**
 * Parse the `aliases` field from gray-matter frontmatter.
 * Handles three formats emitted by Obsidian:
 *   1. YAML list  → gray-matter produces a JS array
 *   2. JSON-stringified array → gray-matter produces a string like '["a","b"]'
 *   3. Plain string → single alias
 */
export function parseAliasField(raw: unknown): string[] {
  const nonempty = (s: string) => s.trim().length > 0;
  if (Array.isArray(raw)) return raw.map(String).filter(nonempty);
  if (typeof raw !== 'string' || !raw.trim()) return [];
  const trimmed = raw.trim();
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed.map(String).filter(nonempty);
  } catch {
    // not valid JSON — treat as a single alias
  }
  return [trimmed];
}

export function parseInlineTags(content: string): string[] {
  const seen = new Set<string>();
  // Strip code blocks to avoid matching # inside them
  const stripped = content.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
  for (const match of stripped.matchAll(
    /(?:^|[\s,;(])#([a-zA-Z_\u00C0-\u024F][a-zA-Z0-9_\-/\u00C0-\u024F]*)/gm,
  )) {
    seen.add(match[1]!);
  }
  return [...seen];
}

export function parseWikilinks(content: string): string[] {
  const seen = new Set<string>();
  let index = 0;
  while (index < content.length) {
    const start = content.indexOf('[[', index);
    if (start === -1) break;
    const end = content.indexOf(']]', start + 2);
    if (end === -1) break;

    const inner = content.slice(start + 2, end);
    const pipeIndex = inner.indexOf('|');
    const headingIndex = inner.indexOf('#');
    const targetEnd = minPositiveIndex(pipeIndex, headingIndex, inner.length);
    const target = inner.slice(0, targetEnd).trim();
    if (target) seen.add(target);
    index = end + 2;
  }
  return [...seen];
}

function minPositiveIndex(first: number, second: number, fallback: number): number {
  const indexes = [first, second].filter((candidate) => candidate >= 0);
  return indexes.length > 0 ? Math.min(...indexes) : fallback;
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- wikilink resolution requires O(N) alias/title lookups
export function resolveWikilinks(content: string, fromPath: string): string[] {
  const db = getDb();
  const raw = parseWikilinks(content);
  if (raw.length === 0) return [];

  // Load all paths, titles and aliases once — O(1) lookups instead of N queries
  const allNotes = db.prepare('SELECT path, title, aliases FROM notes').all() as {
    path: string;
    title: string;
    aliases: string | null;
  }[];

  const pathSet = new Set(allNotes.map((n) => n.path));

  // titleMap: NFD-normalized + lowercased for reliable cross-platform matching.
  // Titles from frontmatter may be NFC; titles derived from filenames on macOS
  // are NFD. Normalising to NFD before lowercasing ensures both forms match.
  const titleMap = new Map(allNotes.map((n) => [n.title.normalize('NFD').toLowerCase(), n.path]));

  // basenameMap: case-insensitive (lowercase key) — Obsidian wikilinks are
  // case-insensitive with respect to the note filename.
  // suffixMap: for partial-path wikilinks like [[sub/note]] that don't match
  // the exact vault-relative path but share a trailing path segment.
  const basenameMap = new Map<string, string>();
  const suffixMap = new Map<string, string>();
  // aliasMap: NFD-normalized + lowercased for the same reason as titleMap.
  const aliasMap = new Map<string, string>();

  for (const n of allNotes) {
    const base = path.basename(n.path).toLowerCase();
    if (!basenameMap.has(base)) basenameMap.set(base, n.path);

    // Build all trailing sub-paths so [[sub/note]] matches 'folder/sub/note.md'
    const parts = n.path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const suffix = parts.slice(i).join('/').toLowerCase();
      if (!suffixMap.has(suffix)) suffixMap.set(suffix, n.path);
    }

    if (n.aliases) {
      try {
        const aliases = JSON.parse(n.aliases) as string[];
        for (const alias of aliases) {
          const key = alias.normalize('NFD').toLowerCase();
          if (alias && !aliasMap.has(key)) {
            aliasMap.set(key, n.path);
          }
        }
      } catch {
        /* ignore malformed aliases */
      }
    }
  }

  const resolved: string[] = [];
  for (const rawTarget of raw) {
    const target = rawTarget.normalize('NFD');
    const withMd = target.endsWith('.md') ? target : target + '.md';
    const base = path.basename(withMd);

    // 1. Exact vault-relative path match (already NFD-normalised)
    if (pathSet.has(withMd) && withMd !== fromPath) {
      resolved.push(withMd);
      continue;
    }

    // 2. Suffix/partial-path match: [[sub/note]] → 'folder/sub/note.md'
    //    Only applied when the target contains a directory separator so we
    //    don't accidentally use this for plain note-name wikilinks.
    if (withMd.includes('/')) {
      const bySuffix = suffixMap.get(withMd.toLowerCase());
      if (bySuffix && bySuffix !== fromPath) {
        resolved.push(bySuffix);
        continue;
      }
    }

    // 3. Basename match — case-insensitive so [[My Note]] finds 'my note.md'
    const byBasename = basenameMap.get(base.toLowerCase());
    if (byBasename && byBasename !== fromPath) {
      resolved.push(byBasename);
      continue;
    }

    // 4. Alias match (NFD-normalised, case-insensitive)
    const byAlias = aliasMap.get(target.toLowerCase());
    if (byAlias && byAlias !== fromPath) {
      resolved.push(byAlias);
      continue;
    }

    // 5. Title match (NFD-normalised, case-insensitive)
    const byTitle = titleMap.get(target.toLowerCase());
    if (byTitle && byTitle !== fromPath) {
      resolved.push(byTitle);
    }
  }

  return [...new Set(resolved)];
}
