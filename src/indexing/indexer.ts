import type { FSWatcher } from 'chokidar';
import { createHash } from 'node:crypto';
import { readdirSync, statSync, type Stats } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  chunkNote,
  createChunkBoundaryIndex,
  refineChunksToFit,
  type Chunk,
} from '../content/chunker.js';
import { CONTENT_POLICY_IDENTITY, mapContentRange } from '../content/content-ignore.js';
import {
  extractMarkdownReferences,
  resolveMarkdownNoteLinks,
} from '../content/markdown-references.js';
import { extractMarkdownNote, extractNoteTags, parseWikilinks } from '../content/note-extractor.js';
import { normalizeNotePath } from '../content/text-normalization.js';
import {
  activeModelName,
  embedDetailed,
  getContextLength,
  getDocumentTokenPolicy,
  prepareEmbeddingInput,
} from '../inference/embedder.js';
import { config } from '../runtime/config.js';
import {
  cleanupIgnoredNotes,
  clearIndexFailures,
  commitIndexedNote,
  deleteNote,
  getNoteMeta,
  getStoredEmbeddingDim,
  hasIndexFailure,
  IndexStorageError,
  readIndexOwner,
  recordIndexFailure,
  renewIndexLease,
  reopenDatabaseForRecovery,
  updateLastIndexed,
  withIndexMutation,
  type NoteReferences,
  type PreparedIndexNote,
} from '../storage/db.js';
import { IndexLeaseLostError } from '../storage/index-ownership.js';
import {
  getExistingNotePathSet,
  getReusableEmbeddings,
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
import {
  ContentFilterBatchCancelledError,
  ContentFilterError,
  type ContentFilter,
} from './content-filter.js';
import { reportIndexProgress, type IndexRunContext as OwnerRunContext } from './index-owner.js';
import { retryIndexWrite } from './index-write.js';

export interface IndexRunContext extends OwnerRunContext {
  readonly contentFilter?: ContentFilter;
  readonly contentPolicySignature?: string;
  readonly reuseEmbeddings?: boolean;
}

export function contentPolicyForRun(run: IndexRunContext): string {
  return run.contentPolicySignature ?? run.contentFilter?.signature ?? CONTENT_POLICY_IDENTITY;
}

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
  const cancelled: string[] = [];
  let filterFailed = false;
  const policy = createIgnorePolicyForFiles(files.map(toPhysicalRelativePath));
  const outcomes = await Promise.allSettled(
    files.map(async (file) => {
      assertIndexRun(run);
      const status = await indexFile(run, file, contextLength, force, policy);
      if (status === 'indexed') result.indexed++;
      else if (status === 'skipped') result.skipped++;
      else if (status.cause instanceof ContentFilterBatchCancelledError) {
        cancelled.push(file);
        filterFailed = true;
      } else {
        result.errors.push({ path: file, error: status.error });
        if (status.cause instanceof ContentFilterError) filterFailed = true;
        if (status.cause instanceof IndexStorageError) result.storageError = status.cause;
      }
    }),
  );
  const failure = outcomes.find((outcome) => outcome.status === 'rejected');
  if (
    filterFailed ||
    (failure?.status === 'rejected' && failure.reason instanceof ContentFilterError)
  )
    await run.contentFilter?.close();
  if (failure?.status === 'rejected') throw failure.reason;
  if (cancelled.length) {
    if (cancelled.length === files.length)
      throw new Error('Content filtering could not start a preparation batch. Retry indexing.');
    // Unattempted siblings are not failed sources. A fresh worker processes only
    // those siblings after every request in the poisoned batch has settled.
    const retried = await indexBatch(run, cancelled, contextLength, force);
    result.indexed += retried.indexed;
    result.skipped += retried.skipped;
    result.errors.push(...retried.errors);
    result.storageError ??= retried.storageError;
  }
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

function toPhysicalRelativePath(fullPath: string): string {
  return path.relative(config.vaultPath, fullPath).split(path.sep).join('/');
}

function toVaultRelativePath(fullPath: string): string {
  return normalizeNotePath(toPhysicalRelativePath(fullPath));
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
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
    throw error;
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
  policy?: Pick<IgnorePolicy, 'isIgnored'>,
  run?: IndexRunContext,
): string[] {
  const files: string[] = [];
  try {
    const activePolicy = policy ?? createIgnorePolicy();
    for (const fullPath of walkDir(config.vaultPath, activePolicy)) {
      const rel = toVaultRelativePath(fullPath);
      if (!activePolicy.isIgnored(rel)) {
        files.push(fullPath);
      }
    }
    if (run) clearIndexFailures(run.lease, '', 'scan');
    return files;
  } catch (error) {
    if (run && !run.signal.aborted && !(error instanceof IndexLeaseLostError)) {
      try {
        recordIndexFailure(run.lease, '', 'scan', fileFingerprint(config.vaultPath, run), error);
      } catch (failure) {
        if (!(failure instanceof IndexLeaseLostError))
          console.error('[indexer] could not record scan failure:', failure);
      }
    }
    throw error;
  }
}

export type PreparedFile =
  | {
      kind: 'prepared';
      note: PreparedIndexNote;
      frontmatterRaw: string;
      modelName: string;
      contentPolicySignature: string;
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
  const contentPolicySignature = contentPolicyForRun(run);
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
  const extracted = extractMarkdownNote(raw, path.basename(fullPath, '.md'));
  const { frontmatter, frontmatterRaw, title, aliases } = extracted;
  const projection = run.contentFilter
    ? await run.contentFilter.project(extracted.content, { signal: run.signal })
    : null;
  const content = projection?.text ?? extracted.content;
  const tags = projection?.segments ? extractNoteTags(content, frontmatter) : extracted.tags;
  const semanticChunks = chunkNote(content, contextLength).filter(
    (chunk) => chunk.text.trim().length > 0,
  );
  let embeddedChunks: EmbeddedChunk[] = [];
  let embeddingContext: string | null = null;
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
    const inputHashes = new WeakMap<Chunk, string>();
    const rememberInput = (chunk: Chunk, input: string): void => {
      inputHashes.set(
        chunk,
        createHash('sha256')
          .update(JSON.stringify(prepareEmbeddingInput(input, 'document')))
          .digest('hex'),
      );
    };
    const inputContext = (prepared: readonly Chunk[]): string => {
      const digest = createHash('sha256').update(
        JSON.stringify([
          'document-input-sha256-v2',
          modelName,
          config.apiBaseUrl,
          tokenPolicy.limit,
        ]),
      );
      for (const chunk of prepared) {
        const fingerprint = inputHashes.get(chunk);
        if (fingerprint === undefined) throw new Error('Prepared embedding input is missing');
        digest.update(fingerprint);
      }
      return digest.digest('hex');
    };
    const dimension = run.reuseEmbeddings ? getStoredEmbeddingDim() : null;
    const preparedInputs =
      run.reuseEmbeddings && dimension !== null
        ? chunks.map((chunk) => {
            const input = project(chunk.text, chunk.headingChain);
            rememberInput(chunk, input);
            return input;
          })
        : undefined;
    const candidateContext = preparedInputs ? inputContext(chunks) : null;
    const reusable =
      candidateContext !== null && dimension !== null
        ? getReusableEmbeddings({
            path: relPath,
            hash,
            title,
            content,
            modelName,
            dimension,
            embeddingContext: candidateContext,
            chunks: chunks.map((chunk) => ({
              text: chunk.text,
              headingPath: chunk.headingChain.length ? chunk.headingChain.join(' > ') : null,
            })),
          })
        : null;
    embeddedChunks = reusable
      ? chunks.map((chunk, index) => ({ chunk, embedding: reusable[index]! }))
      : await embedChunksWithRecovery({
          source: content,
          chunks,
          preparedInputs,
          boundaryIndex,
          project,
          onPreparedInput: rememberInput,
          embed: (texts) => {
            assertIndexRun(run);
            return embedDetailed(texts, 'document', { signal: run.signal });
          },
        });
    // Recovery keeps each accepted leaf object, but may replace and reorder the
    // initial chunks. Only an identical accepted sequence can use its earlier proof.
    embeddingContext =
      candidateContext !== null &&
      embeddedChunks.length === chunks.length &&
      embeddedChunks.every(({ chunk }, index) => chunk === chunks[index])
        ? candidateContext
        : inputContext(embeddedChunks.map(({ chunk }) => chunk));
  }
  assertIndexRun(run);
  return {
    kind: 'prepared',
    frontmatterRaw,
    modelName,
    contentPolicySignature,
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
      embeddingContext,
      chunks: embeddedChunks.map(({ chunk, embedding }) => ({
        text: chunk.text,
        headingPath: chunk.headingChain.length > 0 ? chunk.headingChain.join(' > ') : null,
        embedding,
        ...(projection?.segments
          ? mapContentRange(projection, chunk.charStart, chunk.charEnd)
          : { charStart: chunk.charStart, charEnd: chunk.charEnd }),
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
  policy?: Pick<IgnorePolicy, 'isIgnored'>,
): Promise<'indexed' | 'skipped' | { error: string; cause?: unknown }> {
  let attemptedFingerprint = fileFingerprint(fullPath, run);
  try {
    const preparationPolicy =
      policy ?? createIgnorePolicyForFiles([toPhysicalRelativePath(fullPath)]);
    for (let attempt = 0; attempt < 2; attempt++) {
      attemptedFingerprint = fileFingerprint(fullPath, run);
      const prepared = await prepareIndexFile(
        run,
        fullPath,
        contextLength ?? (await getContextLength()),
        preparationPolicy,
        force,
      );
      assertIndexRun(run);
      if (prepared.kind === 'ignored') return 'skipped';
      if (prepared.kind === 'missing') {
        const removed = await retryIndexWrite(run, () =>
          withIndexMutation(run.lease, () => {
            try {
              statSync(fullPath);
              return false;
            } catch (error) {
              if (
                !error ||
                typeof error !== 'object' ||
                !('code' in error) ||
                error.code !== 'ENOENT'
              )
                throw error;
            }
            deleteNote(run.lease, prepared.path);
            return true;
          }),
        );
        if (!removed) continue;
        bumpIndexVersion();
        throw new Error(`ENOENT: note no longer exists, ${prepared.path}`);
      }
      if (prepared.kind === 'unchanged') {
        if (prepared.updateMtime) updateNoteMtime(run.lease, prepared.mtime, prepared.path);
        return 'skipped';
      }
      const published = await retryIndexWrite(run, () =>
        withIndexMutation(run.lease, () => {
          // Recheck only after SQLite admits this attempt. A busy wait may have
          // allowed another process or editor to replace/delete the source.
          let current: Stats;
          try {
            current = statSync(fullPath);
          } catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
              deleteNote(run.lease, prepared.note.path);
              return 'skipped' as const;
            }
            throw error;
          }
          if (
            current.mtimeMs !== prepared.fingerprint.mtimeMs ||
            current.size !== prepared.fingerprint.size
          )
            return 'changed' as const;
          if (
            createIgnorePolicyForFiles([toPhysicalRelativePath(fullPath)]).isIgnored(
              prepared.note.path,
            )
          ) {
            deleteNote(run.lease, prepared.note.path, true);
            return 'skipped' as const;
          }
          commitIndexedNote(
            run.lease,
            prepared.note,
            {
              modelName: prepared.modelName,
              contentPolicySignature: prepared.contentPolicySignature,
            },
            resolvePreparedReferences(prepared.note, prepared.frontmatterRaw),
          );
          return 'indexed' as const;
        }),
      );
      if (published === 'changed') continue;
      bumpIndexVersion();
      return published;
    }
    throw new Error(
      'The file kept changing during indexing; it will be retried after the next change.',
    );
  } catch (error) {
    if (run.signal.aborted || error instanceof IndexLeaseLostError) throw error;
    if (error instanceof ContentFilterBatchCancelledError)
      return { error: error.message, cause: error };
    if (error instanceof ContentFilterError && error.scope === 'worker') {
      recordIndexFailure(run.lease, '', 'content-filter', attemptedFingerprint, error);
      throw error;
    }
    recordFileFailure(run, fullPath, attemptedFingerprint, error);
    if (process.env.LOG_LEVEL === 'debug')
      console.error('[indexer] error indexing', fullPath, error);
    return { error: error instanceof Error ? error.message : String(error), cause: error };
  }
}

function recordFileFailure(
  run: IndexRunContext,
  fullPath: string,
  fingerprint: string,
  error: unknown,
): void {
  try {
    recordIndexFailure(run.lease, toVaultRelativePath(fullPath), 'index', fingerprint, error);
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
): Promise<'indexed' | 'skipped' | { error: string; cause?: unknown }> {
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
export function cleanupStaleNotes(
  run: IndexRunContext,
  fsPaths?: Set<string>,
  policy = createIgnorePolicy(),
): void {
  try {
    run.signal.throwIfAborted();
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
    clearIndexFailures(run.lease, '', 'cleanup');
  } catch (error) {
    if (run.signal.aborted || error instanceof IndexLeaseLostError) throw error;
    try {
      recordIndexFailure(run.lease, '', 'cleanup', JSON.stringify(config.ignorePatterns), error);
    } catch (failure) {
      if (failure instanceof IndexLeaseLostError) throw failure;
      console.error('[indexer] could not record cleanup failure:', failure);
    }
    throw error;
  }
}

function scanAndCleanup(run: IndexRunContext): { files: string[]; policy: IgnorePolicy } {
  let operation = 'scan';
  try {
    return withIndexMutation(run.lease, () => {
      // A retry must scan after admission instead of deleting against an old
      // directory snapshot. No asynchronous work runs under this write lock.
      const policy = createIgnorePolicy();
      const files = scanVault(policy);
      operation = 'cleanup';
      cleanupStaleNotes(run, new Set(files.map(toVaultRelativePath)), policy);
      clearIndexFailures(run.lease, '', 'scan');
      return { files, policy };
    });
  } catch (error) {
    const busy =
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED');
    if (!busy && !run.signal.aborted && !(error instanceof IndexLeaseLostError)) {
      try {
        recordIndexFailure(run.lease, '', operation, fileFingerprint(config.vaultPath, run), error);
      } catch (failure) {
        if (!(failure instanceof IndexLeaseLostError))
          console.error('[indexer] could not record reconciliation failure:', failure);
      }
    }
    throw error;
  }
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
  const { files } = await runWithDatabaseRecovery(
    run,
    'stale-note cleanup',
    () => scanAndCleanup(run),
    options.recoverDatabase,
  );
  reportIndexProgress(run, files.length, 0);

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
    reportIndexProgress(run, files.length, processed);
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

function fileFingerprint(fullPath: string, run: IndexRunContext): string {
  let fingerprint = 'missing';
  try {
    const stat = statSync(fullPath);
    fingerprint = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    /* Missing paths retry when created. */
  }
  return `${activeModelName()}:${config.apiBaseUrl}:${contentPolicyForRun(run)}:${fingerprint}`;
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
    // Keep the filesystem spelling; only database-relative keys use NFD.
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
          (file) =>
            !hasIndexFailure(toVaultRelativePath(file), 'index', fileFingerprint(file, run)),
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
  const { files } = await runWithDatabaseRecovery(run, 'background stale-note cleanup', () =>
    scanAndCleanup(run),
  );
  enqueue(run, files);
  await processQueue(run, contextLength);
}

export interface WatcherHandle {
  /** Startup has settled, including cancellation or an error reported on stderr. */
  ready: Promise<void>;
  /** A fatal observation error, or undefined on normal close. Never rejects. */
  stopped: Promise<Error | undefined>;
  /** Stop observation and pending debounce timers; queued indexing has its own lifecycle. */
  close(): Promise<void>;
}

export function startWatcher(contextLength: number, run: IndexRunContext): WatcherHandle {
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
  let settleStopped!: (error?: Error) => void;
  const stopped = new Promise<Error | undefined>((resolve) => {
    settleStopped = resolve;
  });
  function fail(error: unknown): void {
    if (closed || run.signal.aborted) return;
    settleStopped(
      error instanceof Error ? error : new Error('Filesystem watcher failed', { cause: error }),
    );
    settleReady();
  }
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
      fail(err);
    });
    return watcher;
  };
  const initialization = import('chokidar')
    .then(({ watch }) => {
      if (closed || run.signal.aborted) return;
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
          if (closed || run.signal.aborted) return;
          void Promise.resolve()
            .then(() => {
              if (closed || run.signal.aborted) return;
              enqueue(run, [filePath]);
              return processQueue(run, contextLength);
            })
            .catch((err) => {
              if (!run.signal.aborted && !(err instanceof IndexLeaseLostError))
                console.warn('[watcher] queue processing error:', err);
            });
        }, config.debounce);
        fileDelays.set(filePath, timer);
      };

      const refreshPolicy = async () => {
        const { files, policy } = await runWithDatabaseRecovery(
          run,
          'watcher ignore policy cleanup',
          () => scanAndCleanup(run),
        );
        if (closed || run.signal.aborted) return;
        watcherPolicy = policy;
        updateControlTargets(policy.controlWatchFiles);
        watcher.add(config.vaultPath);
        enqueue(run, files);
        void processQueue(run, contextLength).catch((err) => {
          if (!run.signal.aborted && !(err instanceof IndexLeaseLostError))
            console.warn('[watcher] queue processing error:', err);
        });
      };
      const schedulePolicyRefresh = () => {
        if (closed || run.signal.aborted || policyRefreshPending || !config.respectGitignore)
          return;
        if (policyTimer) clearTimeout(policyTimer);
        policyTimer = setTimeout(() => {
          policyTimer = undefined;
          if (closed || run.signal.aborted) return;
          policyRefreshPending = true;
          void withIndexingDbLock(async () => {
            policyRefreshPending = false;
            if (closed || run.signal.aborted) return;
            await refreshPolicy();
          }).catch((err) => {
            if (!closed && !run.signal.aborted && !(err instanceof IndexLeaseLostError))
              console.warn('[watcher] ignore policy refresh error:', err);
          });
        }, config.debounce);
      };
      updateControlTargets(watcherPolicy.controlWatchFiles);

      const safeHandleFileChange = (filePath: string) => {
        if (closed || run.signal.aborted) return;
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
        if (closed || run.signal.aborted || pendingUnlinks.has(filePath)) return;
        pendingUnlinks.add(filePath);
        void withIndexingDbLock(async () => {
          try {
            if (closed || run.signal.aborted) return;
            if (path.basename(filePath) === '.gitignore') {
              schedulePolicyRefresh();
              return;
            }
            if (!filePath.endsWith('.md')) return;
            const rel = toVaultRelativePath(filePath);
            if (hasIndexFailure(rel, 'delete', fileFingerprint(filePath, run))) return;
            const existing = fileDelays.get(filePath);
            if (existing) {
              clearTimeout(existing);
              fileDelays.delete(filePath);
            }
            const deleted = await runWithDatabaseRecovery(run, 'watcher unlink', () =>
              withIndexMutation(run.lease, () => {
                try {
                  statSync(filePath);
                  return false;
                } catch (error) {
                  if (!(
                    error &&
                    typeof error === 'object' &&
                    'code' in error &&
                    error.code === 'ENOENT'
                  ))
                    throw error;
                }
                deleteNote(run.lease, rel);
                bumpIndexVersion();
                return true;
              }),
            );
            if (!deleted && !closed && !run.signal.aborted) handleFileChange(filePath);
          } catch (err) {
            if (run.signal.aborted || err instanceof IndexLeaseLostError) return;
            const msg = err instanceof Error ? err.message : String(err);
            try {
              recordIndexFailure(
                run.lease,
                toVaultRelativePath(filePath),
                'delete',
                fileFingerprint(filePath, run),
                err,
              );
            } catch (failure) {
              if (!(failure instanceof IndexLeaseLostError))
                console.error('[watcher] could not record delete failure:', failure);
            }
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
      fail(err);
    });
  const handle: WatcherHandle = {
    ready,
    stopped,
    close() {
      run.signal.removeEventListener('abort', onAbort);
      closed = true;
      settleReady();
      settleStopped();
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
  const onAbort = () => {
    // The owner awaits close again during cleanup; attach a rejection handler now
    // so an early close failure cannot become an unhandled rejection.
    void handle.close().catch(() => undefined);
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
