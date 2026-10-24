import type { FSWatcher } from 'chokidar';
import { createHash } from 'node:crypto';
import { readdirSync, statSync, type Stats } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chunkNote, createChunkBoundaryIndex, refineChunksToFit } from '../content/chunker.js';
import {
  extractMarkdownReferences,
  resolveMarkdownNoteLinks,
} from '../content/markdown-references.js';
import { extractMarkdownNote, parseWikilinks } from '../content/note-extractor.js';
import { normalizeNotePath } from '../content/text-normalization.js';
import {
  activeModelName,
  embedDetailed,
  getContextLength,
  getDocumentTokenPolicy,
} from '../inference/embedder.js';
import { config } from '../runtime/config.js';
import {
  deleteNote,
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
} from '../storage/db.js';
import {
  getExistingNotePathSet,
  readWikiCatalogRows,
  storePopulateMissingLinks,
  storePopulateMissingMarkdownReferences,
  storeResolveAllLinks,
  storeResolveAllMarkdownReferences,
  updateNoteMtime,
} from '../storage/index-queries.js';
import { bumpIndexVersion } from '../storage/index-state.js';
import {
  createIgnorePolicy,
  createIgnorePolicyForFiles,
  type IgnorePolicy,
} from '../vault/ignore.js';
import {
  createDocumentTextProjector,
  embedChunksWithRecovery,
  type EmbeddedChunk,
} from './chunk-embedding.js';

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
  const policy = createIgnorePolicyForFiles(files.map(toVaultRelativePath));
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
  return normalizeNotePath(path.relative(config.vaultPath, fullPath).split(path.sep).join('/'));
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

function* walkDir(dir: string, policy: Pick<IgnorePolicy, 'isIgnored'>): Generator<string> {
  let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[];
  try {
    entries = readdirSync(dir, {
      withFileTypes: true,
      encoding: 'utf-8',
    });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const rel = toVaultRelativePath(full);
      if (!policy.isIgnored(rel + '/')) {
        yield* walkDir(full, policy);
      }
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      yield full;
    }
  }
}

export function scanVault(
  policy: Pick<IgnorePolicy, 'isIgnored'> = createIgnorePolicy(),
): string[] {
  const files: string[] = [];
  for (const fullPath of walkDir(config.vaultPath, policy)) {
    const rel = toVaultRelativePath(fullPath);
    if (!policy.isIgnored(rel)) {
      files.push(fullPath);
    }
  }
  return files;
}

export async function indexFile(
  fullPath: string,
  contextLength?: number,
  force = false,
  policy: Pick<IgnorePolicy, 'isIgnored'> = createIgnorePolicy(),
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
      updateNoteMtime(mtime, relPath);
      return 'skipped';
    }

    const { frontmatter, content, frontmatterRaw, title, tags, aliases } = extractMarkdownNote(
      raw,
      path.basename(fullPath, '.md'),
    );

    const modelName = activeModelName();
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

    upsertNote(
      {
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
      },
      { modelName },
    );

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
  storePopulateMissingLinks(resolveWikilinks);
}

/**
 * One-time migration: populate resolved Markdown file links and external URLs
 * from stored note content for all notes indexed before this feature existed.
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function populateMissingMarkdownReferences(): Promise<void> {
  storePopulateMissingMarkdownReferences(resolveMarkdownReferencesForNote);
}

/**
 * Re-resolve wikilinks for ALL indexed notes unconditionally.
 * Called after every full vault reindex so that notes whose targets
 * didn't exist at index time get their links backfilled.
 */
// eslint-disable-next-line @typescript-eslint/require-await
async function resolveAllLinks(): Promise<void> {
  storeResolveAllLinks(createWikilinkResolver);
}

// eslint-disable-next-line @typescript-eslint/require-await
async function resolveAllMarkdownReferences(): Promise<void> {
  storeResolveAllMarkdownReferences(resolveMarkdownReferencesForNote);
}

/**
 * Remove notes that no longer belong in the index:
 * - notes matching updated ignore patterns
 * - notes whose files were deleted from disk
 * Called on server startup and during full reindex.
 */
export function cleanupStaleNotes(fsPaths?: Set<string>, policy = createIgnorePolicy()): void {
  let deleted = 0;

  // Newly ignored notes: file still exists on disk, keep their link entries
  // so backlinks from ignored notes remain visible in search results
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
    const dbPaths = [...getExistingNotePathSet()];
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
  const policy = createIgnorePolicy();
  const files = scanVault(policy);
  const fsPaths = new Set(files.map(toVaultRelativePath));
  await runWithDatabaseRecovery(
    'stale-note cleanup',
    () => cleanupStaleNotes(fsPaths, policy),
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
    let failedCount = 0;

    if (total > 0) {
      process.stderr.write(`Indexing vault...\n`);
    }

    try {
      const logEvery = Math.max(config.batchSize, Math.floor(total / 10));
      while (_indexQueue.length > 0) {
        const batch = _indexQueue.splice(0, config.batchSize);
        const batchResult = await indexBatchWithRecovery(
          batch,
          contextLength,
          false,
          recoverDatabaseSidecarsForIndexing,
        );
        for (const error of batchResult.errors) {
          process.stderr.write(`[indexer] ${error.path}: ${error.error}\n`);
          failedCount++;
        }
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
        const errors = failedCount > 0 ? ` — ${failedCount} errors` : '';
        process.stderr.write(`Indexing complete in ${elapsed}${errors}\n`);
      }
    } finally {
      _isIndexing = false;
    }
  });
}

export async function startBackgroundIndexing(contextLength: number): Promise<void> {
  const policy = createIgnorePolicy();
  const files = scanVault(policy);
  const fsPaths = new Set(files.map(toVaultRelativePath));
  await withIndexingDbLock(() => {
    return runWithDatabaseRecovery(
      'background stale-note cleanup',
      () => cleanupStaleNotes(fsPaths, policy),
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

export interface WatcherHandle {
  /** Startup has settled, including cancellation or an error reported on stderr. */
  ready: Promise<void>;
  /** Stop observation and pending debounce timers; queued indexing has its own lifecycle. */
  close(): Promise<void>;
}

export function startWatcher(contextLength: number): WatcherHandle {
  const fileDelays = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingUnlinks = new Set<string>();
  const watchers: FSWatcher[] = [];
  const pendingReady = new Set<FSWatcher>();
  let policyTimer: ReturnType<typeof setTimeout> | undefined;
  let policyRefreshPending = false;
  let closed = false;
  let settleReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    settleReady = resolve;
  });
  let closing: Promise<void> | undefined;
  let lastErrorLog = -Infinity;
  const ownWatcher = (watcher: FSWatcher) => {
    watchers.push(watcher);
    pendingReady.add(watcher);
    watcher.on('ready', () => {
      pendingReady.delete(watcher);
      if (pendingReady.size === 0) settleReady();
    });
    watcher.on('error', (err: unknown) => {
      const now = Date.now();
      if (!closed && now - lastErrorLog >= 30_000) {
        lastErrorLog = now;
        console.warn('[watcher] filesystem watch error; index updates may be incomplete:', err);
      }
      settleReady();
    });
    return watcher;
  };
  const initialization = import('chokidar')
    .then(({ watch }) => {
      if (closed) return;
      let watcherPolicy = createIgnorePolicy();
      const watcher = ownWatcher(
        watch(config.vaultPath, {
          backend: 'auto',
          ignored: (filePath: string, stats?: Stats) => {
            const base = path.basename(filePath);
            if (base === '.gitignore') return !config.respectGitignore;
            const rel = toVaultRelativePath(filePath);
            if (rel === '') return false;
            try {
              if ((stats ?? statSync(filePath)).isDirectory()) {
                return watcherPolicy.isIgnored(rel + '/');
              }
            } catch {
              // A vanished path can be a directory. Chokidar checks ancestors
              // when reconciling deletions, so applying the file extension filter
              // here would hide unlink events for all of its former children.
              return watcherPolicy.isIgnored(rel) && watcherPolicy.isIgnored(rel + '/');
            }
            if (!base.endsWith('.md')) return true;
            return watcherPolicy.isIgnored(rel);
          },
          persistent: true,
          ignoreInitial: true,
        }),
      );
      let controlWatcher: FSWatcher | undefined;
      let controlFiles: readonly string[] = [];
      let controlKeys = new Set<string>();
      let ancestorKeys = new Set<string>();
      const controlKey = (file: string) => path.resolve(file);
      const updateControlTargets = (policyFiles: readonly string[]) => {
        // A deleted gitfile removes the context. Keep only that known locator
        // so recreating it restores the repository without discovering new roots.
        const nextFiles =
          policyFiles.length > 0
            ? policyFiles
            : controlFiles.filter((file) => path.basename(file) === '.git');
        const previousKeys = controlKeys;
        controlKeys = new Set(nextFiles.map(controlKey));
        ancestorKeys = new Set();
        for (const file of nextFiles) {
          for (let parent = path.dirname(file); ; parent = path.dirname(parent)) {
            ancestorKeys.add(controlKey(parent));
            if (parent === path.dirname(parent)) break;
          }
        }
        if (controlWatcher) {
          const added = nextFiles.filter((file) => !previousKeys.has(controlKey(file)));
          const removed = controlFiles.filter((file) => !controlKeys.has(controlKey(file)));
          if (added.length > 0) controlWatcher.add(added);
          if (removed.length > 0) controlWatcher.unwatch(removed);
        } else if (nextFiles.length > 0) {
          controlWatcher = ownWatcher(
            watch([...nextFiles], {
              // Native missing-file watches can miss the first creation on macOS.
              // Poll only these metadata files; the vault tree keeps its native backend.
              backend: 'polling',
              pollingInterval: 1000,
              persistent: true,
              ignoreInitial: true,
              ignored: (file: string) =>
                !controlKeys.has(controlKey(file)) && !ancestorKeys.has(controlKey(file)),
            }),
          );
          const changed = (file: string) => {
            if (controlKeys.has(controlKey(file))) schedulePolicyRefresh();
          };
          controlWatcher.on('add', changed);
          controlWatcher.on('change', changed);
          controlWatcher.on('unlink', changed);
        }
        controlFiles = nextFiles;
      };

      const handleFileChange = (filePath: string) => {
        const existing = fileDelays.get(filePath);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
          fileDelays.delete(filePath);
          if (closed) return;
          // Keep the filesystem spelling; only database-relative keys use NFD.
          const normalizedPath = path.normalize(filePath);
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

      const refreshPolicy = async () => {
        const nextPolicy = createIgnorePolicy();
        const files = scanVault(nextPolicy);
        const fsPaths = new Set(files.map(toVaultRelativePath));
        await runWithDatabaseRecovery(
          'watcher ignore policy cleanup',
          () => cleanupStaleNotes(fsPaths, nextPolicy),
          recoverDatabaseSidecarsForIndexing,
        );
        if (closed) return;
        watcherPolicy = nextPolicy;
        updateControlTargets(nextPolicy.controlWatchFiles);
        watcher.add(config.vaultPath);
        for (const file of files) {
          const physicalPath = path.normalize(file);
          if (!_indexQueue.includes(physicalPath)) {
            _indexQueue.push(physicalPath);
            _totalExpected++;
          }
        }
        void processQueue(contextLength).catch((err) => {
          console.warn('[watcher] queue processing error:', err);
        });
      };
      const schedulePolicyRefresh = () => {
        if (closed || policyRefreshPending || !config.respectGitignore) return;
        if (policyTimer) clearTimeout(policyTimer);
        policyTimer = setTimeout(() => {
          policyTimer = undefined;
          if (closed) return;
          policyRefreshPending = true;
          void withIndexingDbLock(async () => {
            policyRefreshPending = false;
            if (closed) return;
            await refreshPolicy();
          }).catch((err) => {
            if (!closed) console.warn('[watcher] ignore policy refresh error:', err);
          });
        }, config.debounce);
      };
      updateControlTargets(watcherPolicy.controlWatchFiles);

      const safeHandleFileChange = (filePath: string) => {
        if (closed) return;
        try {
          if (path.basename(filePath) === '.gitignore') {
            schedulePolicyRefresh();
            return;
          }
          if (!filePath.endsWith('.md')) return;
          handleFileChange(filePath);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[watcher] file change error for ${filePath}: ${msg}`);
        }
      };

      const safeHandleUnlink = (filePath: string) => {
        if (closed || pendingUnlinks.has(filePath)) return;
        if (path.basename(filePath) === '.gitignore') {
          schedulePolicyRefresh();
          return;
        }
        pendingUnlinks.add(filePath);
        void withIndexingDbLock(async () => {
          try {
            if (closed) return;
            if (!filePath.endsWith('.md')) return;
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
      if (!closed) console.warn('[watcher] chokidar load error:', err);
      settleReady();
    });
  return {
    ready,
    close() {
      closed = true;
      settleReady();
      for (const timer of fileDelays.values()) clearTimeout(timer);
      fileDelays.clear();
      if (policyTimer) clearTimeout(policyTimer);
      closing ??= initialization.then(async () => {
        const results = await Promise.allSettled(
          watchers.map((watcher) => Promise.resolve().then(() => watcher.close())),
        );
        const errors = results
          .filter((result) => result.status === 'rejected')
          .map((result) => result.reason as unknown);
        if (errors.length > 0)
          throw new AggregateError(errors, 'Failed to close filesystem watchers');
      });
      return closing;
    },
  };
}

interface WikiCatalog {
  pathSet: Set<string>;
  titleMap: Map<string, string>;
  basenameMap: Map<string, string>;
  suffixMap: Map<string, string>;
  aliasMap: Map<string, string>;
}

function loadWikiCatalog(): WikiCatalog {
  const allNotes = readWikiCatalogRows();

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

  return { pathSet, titleMap, basenameMap, suffixMap, aliasMap };
}

function resolveWikiTargets(raw: string[], fromPath: string, catalog: WikiCatalog): string[] {
  const { pathSet, titleMap, basenameMap, suffixMap, aliasMap } = catalog;

  const resolved: string[] = [];
  for (const rawTarget of raw) {
    const target = normalizeNotePath(rawTarget);
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

function createWikilinkResolver(): (content: string, fromPath: string) => string[] {
  let catalog: WikiCatalog | undefined;
  return (content, fromPath) => {
    const raw = parseWikilinks(content);
    if (raw.length === 0) return [];
    catalog ??= loadWikiCatalog();
    return resolveWikiTargets(raw, fromPath, catalog);
  };
}

export function resolveWikilinks(content: string, fromPath: string): string[] {
  return createWikilinkResolver()(content, fromPath);
}
