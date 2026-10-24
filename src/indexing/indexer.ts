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
  cleanupIgnoredNotes,
  commitIndexedNote,
  deleteNote,
  getNoteMeta,
  hasIndexFailure,
  IndexStorageError,
  readIndexOwner,
  recordIndexFailure,
  renewIndexLease,
  reopenDatabaseForRecovery,
  updateLastIndexed,
  type NoteReferences,
  type PreparedIndexNote,
} from '../storage/db.js';
import { IndexLeaseLostError } from '../storage/index-ownership.js';
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
import type { IndexRunContext } from './index-owner.js';
import { retryIndexWrite } from './index-write.js';

export interface IndexResult {
  indexed: number;
  skipped: number;
  errors: Array<{ path: string; error: string }>;
}

function assertIndexRun(run: IndexRunContext): void {
  run.signal.throwIfAborted();
  const owner = readIndexOwner();
  if (owner.token !== run.lease.token || owner.expiresAt <= Date.now())
    throw new IndexLeaseLostError();
}

function recoverDatabaseForIndexing(run: IndexRunContext): void {
  reopenDatabaseForRecovery(run.lease);
  bumpIndexVersion();
}

async function runWithDatabaseRecovery<T>(
  run: IndexRunContext,
  label: string,
  operation: () => T | Promise<T>,
  recoverDatabase?: () => void,
): Promise<T> {
  assertIndexRun(run);
  try {
    return await retryIndexWrite(run, operation);
  } catch (error) {
    if (!(error instanceof IndexStorageError)) throw error;
    process.stderr.write(
      '[auto-heal] Reopening SQLite after a storage error during ' + label + '; retrying once.\n',
    );
    if (recoverDatabase) recoverDatabase();
    else recoverDatabaseForIndexing(run);
    assertIndexRun(run);
    return operation();
  }
}

interface IndexBatchResult extends IndexResult {
  storageError?: IndexStorageError;
}

async function indexBatch(
  run: IndexRunContext,
  files: readonly string[],
  contextLength: number,
  force: boolean,
): Promise<IndexBatchResult> {
  const result: IndexBatchResult = { indexed: 0, skipped: 0, errors: [] };
  const policy = createIgnorePolicyForFiles(files.map(toVaultRelativePath));
  await Promise.all(
    files.map(async (file) => {
      assertIndexRun(run);
      const status = await indexFile(run, file, contextLength, force, policy);
      if (status === 'indexed') result.indexed++;
      else if (status === 'skipped') result.skipped++;
      else {
        result.errors.push({ path: file, error: status.error });
        if (status.cause instanceof IndexStorageError) result.storageError = status.cause;
      }
    }),
  );
  return result;
}

async function indexBatchWithRecovery(
  run: IndexRunContext,
  batch: readonly string[],
  contextLength: number,
  force: boolean,
  recoverDatabase?: () => void,
): Promise<IndexResult> {
  const result = await indexBatch(run, batch, contextLength, force);
  if (!result.storageError) return result;
  process.stderr.write(
    '[auto-heal] Reopening SQLite after an indexing storage error; retrying once.\n',
  );
  if (recoverDatabase) recoverDatabase();
  else recoverDatabaseForIndexing(run);
  assertIndexRun(run);
  const retry = await indexBatch(run, batch, contextLength, force);
  if (retry.storageError) throw retry.storageError;
  return retry;
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

function* walkDir(dir: string, policy: IgnorePolicy): Generator<string> {
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

export function scanVault(): string[] {
  const files: string[] = [];
  const policy = createIgnorePolicy();
  for (const fullPath of walkDir(config.vaultPath, policy)) {
    const rel = toVaultRelativePath(fullPath);
    if (!policy.isIgnored(rel)) {
      files.push(fullPath);
    }
  }
  return files;
}

export type PreparedFile =
  | {
      kind: 'prepared';
      note: PreparedIndexNote;
      frontmatterRaw: string;
      modelName: string;
      fingerprint: { mtimeMs: number; size: number };
    }
  | { kind: 'unchanged'; path: string; mtime: number; updateMtime: boolean }
  | { kind: 'ignored' }
  | { kind: 'missing'; path: string };

export async function prepareIndexFile(
  run: IndexRunContext,
  fullPath: string,
  contextLength: number,
  policy: Pick<IgnorePolicy, 'isIgnored'>,
  force = false,
): Promise<PreparedFile> {
  assertIndexRun(run);
  const relPath = toVaultRelativePath(fullPath);
  const modelName = activeModelName();
  if (policy.isIgnored(relPath)) return { kind: 'ignored' };
  let stat: Stats;
  let raw: string;
  try {
    stat = statSync(fullPath);
    const existing = force ? undefined : getNoteMeta(relPath);
    if (existing && existing.mtime === stat.mtimeMs) {
      return { kind: 'unchanged', path: relPath, mtime: stat.mtimeMs, updateMtime: false };
    }
    raw = await readFile(fullPath, 'utf-8');
    const hash = createHash('md5').update(raw).digest('hex');
    if (existing && existing.hash === hash) {
      return { kind: 'unchanged', path: relPath, mtime: stat.mtimeMs, updateMtime: true };
    }
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { kind: 'missing', path: relPath };
    }
    throw error;
  }
  const hash = createHash('md5').update(raw).digest('hex');
  const { frontmatter, content, frontmatterRaw, title, tags, aliases } = extractMarkdownNote(
    raw,
    path.basename(fullPath, '.md'),
  );
  const semanticChunks = chunkNote(content, contextLength).filter(
    (chunk) => chunk.text.trim().length > 0,
  );
  let embeddedChunks: EmbeddedChunk[] = [];
  if (semanticChunks.length > 0) {
    assertIndexRun(run);
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
      embed: (texts) => {
        assertIndexRun(run);
        return embedDetailed(texts, 'document', { signal: run.signal });
      },
    });
  }
  assertIndexRun(run);
  return {
    kind: 'prepared',
    frontmatterRaw,
    modelName,
    fingerprint: { mtimeMs: stat.mtimeMs, size: stat.size },
    note: {
      path: relPath,
      title,
      tags,
      aliases,
      content,
      frontmatter,
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
  };
}

export function createPreparedReferenceResolver(rows: ReturnType<typeof readWikiCatalogRows>) {
  const wiki = createWikilinkResolver(rows);
  let paths: Set<string> | undefined;
  return (
    note: Pick<PreparedIndexNote, 'path' | 'content'>,
    frontmatterRaw: string,
  ): NoteReferences => {
    const references = extractMarkdownReferences(note.content);
    const links = wiki(frontmatterRaw + '\n' + note.content, note.path);
    if (references.localDestinations.length === 0)
      return { links, markdownLinks: [], urls: references.urls };
    paths ??= new Set(rows.map((row) => row.path));
    const markdownLinks = resolveMarkdownNoteLinks(
      note.path,
      references.localDestinations.map((link) => link.destination),
      paths,
    );
    return { links, markdownLinks, urls: references.urls };
  };
}

function resolvePreparedReferences(
  note: PreparedIndexNote,
  frontmatterRaw: string,
): NoteReferences {
  const text = frontmatterRaw + '\n' + note.content;
  const wiki = parseWikilinks(text);
  const references = extractMarkdownReferences(note.content);
  // Ordinary plain notes must not scan the catalog as the vault grows.
  if (wiki.length === 0) {
    if (references.localDestinations.length === 0)
      return { links: [], markdownLinks: [], urls: references.urls };
    const paths = getExistingNotePathSet();
    paths.add(note.path);
    return {
      links: [],
      markdownLinks: resolveMarkdownNoteLinks(
        note.path,
        references.localDestinations.map((link) => link.destination),
        paths,
      ),
      urls: references.urls,
    };
  }
  const rows = readWikiCatalogRows();
  const replacement = {
    path: note.path,
    title: note.title,
    aliases: JSON.stringify(note.aliases ?? []),
  };
  const index = rows.findIndex((row) => row.path === note.path);
  if (index < 0) rows.push(replacement);
  else rows[index] = replacement;
  return createPreparedReferenceResolver(rows)(note, frontmatterRaw);
}

export async function indexFile(
  run: IndexRunContext,
  fullPath: string,
  contextLength?: number,
  force = false,
  policy: Pick<IgnorePolicy, 'isIgnored'> = createIgnorePolicy(),
): Promise<'indexed' | 'skipped' | { error: string; cause?: unknown }> {
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const prepared = await prepareIndexFile(
        run,
        fullPath,
        contextLength ?? (await getContextLength()),
        policy,
        force,
      );
      assertIndexRun(run);
      if (prepared.kind === 'ignored') return 'skipped';
      if (prepared.kind === 'missing') {
        deleteNote(run.lease, prepared.path);
        bumpIndexVersion();
        throw new Error(`ENOENT: note no longer exists, ${prepared.path}`);
      }
      if (prepared.kind === 'unchanged') {
        if (prepared.updateMtime) updateNoteMtime(run.lease, prepared.mtime, prepared.path);
        return 'skipped';
      }
      let current: Stats;
      try {
        current = statSync(fullPath);
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
          deleteNote(run.lease, prepared.note.path);
          bumpIndexVersion();
          return 'skipped';
        }
        throw error;
      }
      if (
        current.mtimeMs !== prepared.fingerprint.mtimeMs ||
        current.size !== prepared.fingerprint.size
      )
        continue;
      if (createIgnorePolicy().isIgnored(prepared.note.path)) {
        deleteNote(run.lease, prepared.note.path, true);
        bumpIndexVersion();
        return 'skipped';
      }
      await retryIndexWrite(run, () =>
        commitIndexedNote(
          run.lease,
          prepared.note,
          { modelName: prepared.modelName },
          resolvePreparedReferences(prepared.note, prepared.frontmatterRaw),
        ),
      );
      bumpIndexVersion();
      return 'indexed';
    }
    throw new Error(
      'The file kept changing during indexing; it will be retried after the next change.',
    );
  } catch (error) {
    if (run.signal.aborted || error instanceof IndexLeaseLostError) throw error;
    recordFileFailure(run, fullPath, error);
    if (process.env.LOG_LEVEL === 'debug')
      console.error('[indexer] error indexing', fullPath, error);
    return { error: error instanceof Error ? error.message : String(error), cause: error };
  }
}

function recordFileFailure(run: IndexRunContext, fullPath: string, error: unknown): void {
  try {
    recordIndexFailure(
      run.lease,
      toVaultRelativePath(fullPath),
      'index',
      fileFingerprint(fullPath),
      error,
    );
  } catch (failure) {
    if (failure instanceof IndexLeaseLostError) throw failure;
    console.error('[indexer] could not record indexing failure:', failure);
  }
}

export async function indexFileWithRecovery(
  run: IndexRunContext,
  fullPath: string,
  contextLength: number,
  force = false,
  recoverDatabase?: () => void,
): Promise<'indexed' | 'skipped' | { error: string }> {
  const result = await indexFile(run, fullPath, contextLength, force);
  if (typeof result !== 'object' || !(result.cause instanceof IndexStorageError)) return result;
  process.stderr.write(
    '[auto-heal] Reopening SQLite after a file indexing storage error; retrying once.\n',
  );
  if (recoverDatabase) recoverDatabase();
  else recoverDatabaseForIndexing(run);
  assertIndexRun(run);
  const retry = await indexFile(run, fullPath, contextLength, force);
  if (typeof retry === 'object' && retry.cause instanceof IndexStorageError) throw retry.cause;
  return retry;
}

/**
 * One-time migration: populate links from stored note content for all notes
 * that were indexed before the links feature was added. No API calls — just
 * wikilink parsing and DB writes.
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function populateMissingLinks(run: IndexRunContext): Promise<void> {
  storePopulateMissingLinks(run.lease, resolveWikilinks);
}

/**
 * One-time migration: populate resolved Markdown file links and external URLs
 * from stored note content for all notes indexed before this feature existed.
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function populateMissingMarkdownReferences(run: IndexRunContext): Promise<void> {
  storePopulateMissingMarkdownReferences(run.lease, resolveMarkdownReferencesForNote);
}

/**
 * Re-resolve wikilinks for ALL indexed notes unconditionally.
 * Called after every full vault reindex so that notes whose targets
 * didn't exist at index time get their links backfilled.
 */
// eslint-disable-next-line @typescript-eslint/require-await
async function resolveAllLinks(run: IndexRunContext): Promise<void> {
  storeResolveAllLinks(run.lease, createWikilinkResolver);
}

// eslint-disable-next-line @typescript-eslint/require-await
async function resolveAllMarkdownReferences(run: IndexRunContext): Promise<void> {
  storeResolveAllMarkdownReferences(run.lease, resolveMarkdownReferencesForNote);
}

/**
 * Remove notes that no longer belong in the index:
 * - notes matching updated ignore patterns
 * - notes whose files were deleted from disk
 * Called on server startup and during full reindex.
 */
export function cleanupStaleNotes(run: IndexRunContext, fsPaths?: Set<string>): void {
  assertIndexRun(run);
  const policy = createIgnorePolicy();
  let deleted = cleanupIgnoredNotes(run.lease, config.ignorePatterns, policy.signature(), (p) =>
    policy.isIgnored(p),
  ).length;
  if (fsPaths)
    for (const notePath of getExistingNotePathSet()) {
      if (!fsPaths.has(notePath)) {
        deleteNote(run.lease, notePath);
        deleted++;
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
  run: IndexRunContext,
  force = false,
  header = 'Indexing vault...',
  options: { requireClean?: boolean; recoverDatabase?: () => void } = {},
): Promise<IndexResult> {
  const files = scanVault();
  const fsPaths = new Set(files.map(toVaultRelativePath));
  await runWithDatabaseRecovery(
    run,
    'stale-note cleanup',
    () => cleanupStaleNotes(run, fsPaths),
    options.recoverDatabase,
  );

  const contextLength = await getContextLength();
  const result: IndexResult = { indexed: 0, skipped: 0, errors: [] };

  if (files.length === 0) {
    await runWithDatabaseRecovery(
      run,
      'link resolution',
      () => resolveAllLinks(run),
      options.recoverDatabase,
    );
    await runWithDatabaseRecovery(
      run,
      'markdown reference resolution',
      () => resolveAllMarkdownReferences(run),
      options.recoverDatabase,
    );
    await runWithDatabaseRecovery(
      run,
      'freshness update',
      () => updateLastIndexed(run.lease),
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
      run,
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
    run,
    'link resolution',
    () => resolveAllLinks(run),
    options.recoverDatabase,
  );
  await runWithDatabaseRecovery(
    run,
    'markdown reference resolution',
    () => resolveAllMarkdownReferences(run),
    options.recoverDatabase,
  );
  if (result.errors.length === 0)
    await runWithDatabaseRecovery(
      run,
      'freshness update',
      () => updateLastIndexed(run.lease),
      options.recoverDatabase,
    );
  return result;
}

function fileFingerprint(fullPath: string): string {
  let fingerprint = 'missing';
  try {
    const stat = statSync(fullPath);
    fingerprint = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    /* Missing paths retry when created. */
  }
  return `${activeModelName()}:${config.apiBaseUrl}:${fingerprint}`;
}

interface IndexQueue {
  token: string;
  paths: Set<string>;
  total: number;
  processed: number;
  running: boolean;
  work?: Promise<void>;
}
let currentQueue: IndexQueue | undefined;
let _indexingDbLock: Promise<void> = Promise.resolve();

/** @internal Reset module-level queue state for test isolation. */
export function resetIndexingState(): void {
  currentQueue = undefined;
  _indexingDbLock = Promise.resolve();
}

function queueFor(run: IndexRunContext): IndexQueue {
  assertIndexRun(run);
  if (currentQueue?.token !== run.lease.token) {
    currentQueue = {
      token: run.lease.token,
      paths: new Set(),
      total: 0,
      processed: 0,
      running: false,
    };
  }
  return currentQueue;
}

function enqueue(run: IndexRunContext, files: readonly string[]): void {
  const queue = queueFor(run);
  for (const file of files) {
    const normalized = path.normalize(file);
    if (!queue.paths.has(normalized)) {
      queue.paths.add(normalized);
      queue.total++;
    }
  }
}

export function getIndexingStatus(): {
  queued: number;
  total: number;
  processed: number;
  isRunning: boolean;
} {
  const owner = readIndexOwner();
  return {
    queued: owner.queued,
    total: owner.total,
    processed: owner.processed,
    isRunning: owner.isRunning && owner.token !== null && owner.expiresAt > Date.now(),
  };
}

function publishProgress(run: IndexRunContext, queue: IndexQueue): void {
  if (
    !renewIndexLease(run.lease, {
      queued: queue.paths.size,
      total: queue.total,
      processed: queue.processed,
      isRunning: queue.running,
    })
  )
    throw new IndexLeaseLostError();
}

async function processQueue(run: IndexRunContext, contextLength: number): Promise<void> {
  const queue = queueFor(run);
  if (queue.work) return queue.work;
  queue.running = true;
  publishProgress(run, queue);
  const work = (async () => {
    let failed = 0;
    try {
      while (queue.paths.size > 0) {
        assertIndexRun(run);
        const batch = Array.from(queue.paths).slice(0, config.batchSize);
        for (const file of batch) queue.paths.delete(file);
        publishProgress(run, queue);
        const retryable = batch.filter(
          (file) => !hasIndexFailure(toVaultRelativePath(file), 'index', fileFingerprint(file)),
        );
        const result = await indexBatchWithRecovery(run, retryable, contextLength, false);
        failed += batch.length - retryable.length;
        for (const error of result.errors) {
          process.stderr.write(`[indexer] ${error.path}: ${error.error}\n`);
          failed++;
        }
        queue.processed += batch.length;
        publishProgress(run, queue);
      }
      const suffix = failed ? ` — ${failed} errors` : '';
      process.stderr.write(`Indexing complete${suffix}\n`);
      if (failed === 0)
        await runWithDatabaseRecovery(run, 'background freshness update', () =>
          updateLastIndexed(run.lease),
        );
    } finally {
      queue.running = false;
      queue.work = undefined;
      if (!run.signal.aborted) {
        try {
          publishProgress(run, queue);
        } catch (error) {
          if (!(error instanceof IndexLeaseLostError))
            console.error('[indexer] could not save progress:', error);
        }
      }
    }
  })();
  queue.work = work;
  return work;
}

export async function drainIndexingRun(run: IndexRunContext): Promise<void> {
  if (currentQueue?.token === run.lease.token) await currentQueue.work?.catch(() => undefined);
}

export async function startBackgroundIndexing(
  run: IndexRunContext,
  contextLength: number,
): Promise<void> {
  const files = scanVault();
  await runWithDatabaseRecovery(run, 'background stale-note cleanup', () =>
    cleanupStaleNotes(run, new Set(files.map(toVaultRelativePath))),
  );
  enqueue(run, files);
  await processQueue(run, contextLength);
}

export interface WatcherHandle {
  /** Startup has settled, including cancellation or an error reported on stderr. */
  ready: Promise<void>;
  /** Stop observation and pending debounce timers; queued indexing has its own lifecycle. */
  close(): Promise<void>;
}

export function startWatcher(contextLength: number, run: IndexRunContext): WatcherHandle {
  const fileDelays = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingUnlinks = new Set<string>();
  let closed = false;
  let settleReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    settleReady = resolve;
  });
  let closeWatcher: (() => Promise<void>) | undefined;
  let closing: Promise<void> | undefined;
  let lastErrorLog = -Infinity;
  const initialization = import('chokidar')
    .then(({ watch }) => {
      if (closed || run.signal.aborted) return;
      let watcherPolicy = createIgnorePolicy();
      const watcher = watch(config.vaultPath, {
        backend: 'auto',
        ignored: (filePath: string, stats?: Stats) => {
          const base = path.basename(filePath);
          if (base === '.gitignore') return false;
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
            return watcherPolicy.isIgnored(rel);
          }
          if (!base.endsWith('.md')) return true;
          return watcherPolicy.isIgnored(rel);
        },
        persistent: true,
        ignoreInitial: true,
      });
      closeWatcher = () => watcher.close();
      watcher.on('ready', settleReady);
      watcher.on('error', (err: unknown) => {
        const now = Date.now();
        if (!closed && now - lastErrorLog >= 30_000) {
          lastErrorLog = now;
          console.warn('[watcher] filesystem watch error; index updates may be incomplete:', err);
        }
        settleReady();
      });

      const handleFileChange = (filePath: string) => {
        const existing = fileDelays.get(filePath);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
          fileDelays.delete(filePath);
          if (closed || run.signal.aborted) return;
          enqueue(run, [filePath]);
          processQueue(run, contextLength).catch((err) => {
            if (!run.signal.aborted && !(err instanceof IndexLeaseLostError))
              console.warn('[watcher] queue processing error:', err);
          });
        }, config.debounce);
        fileDelays.set(filePath, timer);
      };

      const handleGitignoreChange = () => {
        void withIndexingDbLock(async () => {
          if (closed || run.signal.aborted) return;
          try {
            watcherPolicy = createIgnorePolicy();
            const files = scanVault();
            const fsPaths = new Set(files.map(toVaultRelativePath));
            await runWithDatabaseRecovery(run, 'watcher gitignore cleanup', () =>
              cleanupStaleNotes(run, fsPaths),
            );
            if (closed || run.signal.aborted) return;
            enqueue(run, files);
            watcher.add(config.vaultPath);
            void processQueue(run, contextLength).catch((err) => {
              if (!run.signal.aborted && !(err instanceof IndexLeaseLostError))
                console.warn('[watcher] queue processing error:', err);
            });
          } catch (err) {
            if (run.signal.aborted || err instanceof IndexLeaseLostError) return;
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[watcher] gitignore change error: ${msg}`);
          }
        });
      };

      const safeHandleFileChange = (filePath: string) => {
        if (closed || run.signal.aborted) return;
        try {
          if (path.basename(filePath) === '.gitignore') {
            handleGitignoreChange();
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
        if (closed || run.signal.aborted || pendingUnlinks.has(filePath)) return;
        pendingUnlinks.add(filePath);
        void withIndexingDbLock(async () => {
          try {
            if (closed || run.signal.aborted) return;
            if (path.basename(filePath) === '.gitignore') {
              handleGitignoreChange();
              return;
            }
            if (!filePath.endsWith('.md')) return;
            const rel = toVaultRelativePath(filePath);
            const existing = fileDelays.get(filePath);
            if (existing) {
              clearTimeout(existing);
              fileDelays.delete(filePath);
            }
            await runWithDatabaseRecovery(run, 'watcher unlink', () => {
              deleteNote(run.lease, rel);
              bumpIndexVersion();
            });
          } catch (err) {
            if (run.signal.aborted || err instanceof IndexLeaseLostError) return;
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
      if (!closed && !run.signal.aborted) console.warn('[watcher] chokidar load error:', err);
      settleReady();
    });
  const handle: WatcherHandle = {
    ready,
    close() {
      run.signal.removeEventListener('abort', onAbort);
      closed = true;
      settleReady();
      for (const timer of fileDelays.values()) clearTimeout(timer);
      fileDelays.clear();
      closing ??= initialization.then(() => closeWatcher?.());
      return closing;
    },
  };
  const onAbort = () => {
    void handle.close();
  };
  run.signal.addEventListener('abort', onAbort, { once: true });
  if (run.signal.aborted) onAbort();
  return handle;
}

interface WikiCatalog {
  pathSet: Set<string>;
  titleMap: Map<string, string>;
  basenameMap: Map<string, string>;
  suffixMap: Map<string, string>;
  aliasMap: Map<string, string>;
}

function loadWikiCatalog(allNotes = readWikiCatalogRows()): WikiCatalog {
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

function createWikilinkResolver(
  rows?: ReturnType<typeof readWikiCatalogRows>,
): (content: string, fromPath: string) => string[] {
  let catalog: WikiCatalog | undefined;
  return (content, fromPath) => {
    const raw = parseWikilinks(content);
    if (raw.length === 0) return [];
    catalog ??= loadWikiCatalog(rows);
    return resolveWikiTargets(raw, fromPath, catalog);
  };
}

export function resolveWikilinks(content: string, fromPath: string): string[] {
  return createWikilinkResolver()(content, fromPath);
}
