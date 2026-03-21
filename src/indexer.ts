import matter from 'gray-matter';
import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chunkNote } from './chunker.js';
import { config } from './config.js';
import {
  deleteNote,
  getDb,
  getNoteMeta,
  getPathsToRemoveForIgnoreChange,
  updateLastIndexed,
  upsertLinks,
  upsertNote,
} from './db.js';
import { embed, getContextLength } from './embedder.js';
import { isIgnored } from './ignore.js';
import { bumpIndexVersion } from './searcher.js';

interface IndexResult {
  indexed: number;
  skipped: number;
  errors: Array<{ path: string; error: string }>;
}

function* walkDir(dir: string): Generator<string> {
  let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[];
  try {
    entries = readdirSync(dir, {
      withFileTypes: true,
      encoding: 'utf-8',
    }) as unknown as typeof entries;
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const rel = path.relative(config.vaultPath, full);
      if (!isIgnored(rel + '/')) {
        yield* walkDir(full);
      }
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      yield full;
    }
  }
}

function scanVault(): string[] {
  const files: string[] = [];
  for (const fullPath of walkDir(config.vaultPath)) {
    const rel = path.relative(config.vaultPath, fullPath);
    if (!isIgnored(rel)) {
      files.push(fullPath);
    }
  }
  return files;
}

export async function indexFile(
  fullPath: string,
  contextLength?: number,
  force = false,
): Promise<'indexed' | 'skipped' | { error: string }> {
  try {
    const stat = statSync(fullPath);
    const mtime = stat.mtimeMs;

    const relPath = path.relative(config.vaultPath, fullPath).normalize('NFD');
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
    const title = (frontmatter.title as string | undefined) ?? path.basename(fullPath, '.md');
    const frontmatterTags: string[] = Array.isArray(frontmatter.tags)
      ? frontmatter.tags.map(String)
      : typeof frontmatter.tags === 'string'
        ? frontmatter.tags.split(',').map((t: string) => t.trim())
        : [];
    const inlineTags = parseInlineTags(content);
    const tags = [...new Set([...frontmatterTags, ...inlineTags])];
    const aliases = parseAliasField(frontmatter.aliases as unknown);

    const ctxLen = contextLength ?? (await getContextLength());
    const chunks = chunkNote(content, ctxLen).filter((c) => c.text.trim().length > 0);

    if (chunks.length === 0) {
      return 'skipped';
    }

    // Prepend title + heading chain to every chunk so embeddings carry document context.
    // Heading markers (# / ## / ###) are stripped for readability in the prefix.
    // Chunks with no headings get just the title. This improves semantic recall for
    // non-first chunks that would otherwise be context-free.
    const textsToEmbed = chunks.map((c) => {
      const cleanChain = c.headingChain.map((h) => h.replace(/^#{1,6}\s+/, ''));
      const prefix = cleanChain.length > 0 ? `${title} > ${cleanChain.join(' > ')}` : title;
      return prefix ? `${prefix}\n${c.text}` : c.text;
    });
    const embeddings = await embed(textsToEmbed, 'document');

    upsertNote({
      path: relPath,
      title,
      tags,
      aliases,
      content,
      frontmatter: frontmatterRaw,
      mtime: stat.mtimeMs,
      hash,
      chunks: chunks.map((c, i) => ({
        text: c.text,
        headingPath: c.headingChain.length > 0 ? c.headingChain.join(' > ') : null,
        embedding: embeddings[i] ?? null,
      })),
    });

    const resolvedLinks = resolveWikilinks(frontmatterRaw + '\n' + content, relPath);
    upsertLinks(relPath, resolvedLinks);

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

/**
 * One-time migration: populate links from stored note content for all notes
 * that were indexed before the links feature was added. No API calls — just
 * wikilink parsing and DB writes.
 */
export async function populateMissingLinks(): Promise<void> {
  const db = getDb();
  const done = (
    db.prepare("SELECT value FROM settings WHERE key = 'links_v1'").get() as
      | { value: string }
      | undefined
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
 * Re-resolve wikilinks for ALL indexed notes unconditionally.
 * Called after every full vault reindex so that notes whose targets
 * didn't exist at index time get their links backfilled.
 */
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

/**
 * Remove notes that no longer belong in the index:
 * - notes matching updated ignore patterns
 * - notes whose files were deleted from disk
 * Called on server startup and during full reindex.
 */
function cleanupStaleNotes(fsPaths?: Set<string>): void {
  let deleted = 0;

  // Newly ignored notes: file still exists on disk, keep their link entries
  // so backlinks from ignored notes remain visible in search results
  const pathsToRemove = getPathsToRemoveForIgnoreChange(config.ignorePatterns);
  for (const p of pathsToRemove) {
    if (isIgnored(p)) {
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

function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

const PROGRESS_BAR_WIDTH = 20;
// Number of completed batches to wait before showing ETA (lets the rate stabilise)
const ETA_WARMUP_BATCHES = 3;

function renderProgressLine(processed: number, total: number, etaStr: string): string {
  const pct = total > 0 ? processed / total : 1;
  const filled = Math.round(pct * PROGRESS_BAR_WIDTH);
  const bar = '█'.repeat(filled) + '░'.repeat(PROGRESS_BAR_WIDTH - filled);
  const pctLabel = `${Math.round(pct * 100)}%`.padStart(4);
  return `  ${bar}  ${pctLabel} (${processed}/${total} notes)${etaStr}`;
}

export async function indexVaultSync(
  force = false,
  header = 'Indexing vault...',
): Promise<IndexResult> {
  const files = scanVault();
  const fsPaths = new Set(files.map((f) => path.relative(config.vaultPath, f).normalize('NFD')));
  cleanupStaleNotes(fsPaths);

  const contextLength = await getContextLength();
  const result: IndexResult = { indexed: 0, skipped: 0, errors: [] };

  if (files.length === 0) {
    await resolveAllLinks();
    updateLastIndexed();
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
    await Promise.all(
      batch.map(async (f) => {
        const status = await indexFile(f, contextLength, force);
        if (status === 'indexed') result.indexed++;
        else if (status === 'skipped') result.skipped++;
        else
          result.errors.push({
            path: f,
            error: typeof status === 'object' ? status.error : 'indexing failed',
          });
      }),
    );

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

  await resolveAllLinks();
  updateLastIndexed();
  return result;
}

const _indexQueue: string[] = [];
let _isIndexing = false;
let _totalExpected = 0;
let _processedCount = 0;

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
      await Promise.all(batch.map((f) => indexFile(f, contextLength)));
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

    updateLastIndexed();

    if (total > 0) {
      const elapsed = formatDuration((Date.now() - startTime) / 1000);
      process.stderr.write(`Indexing complete in ${elapsed}\n`);
    }
  } finally {
    _isIndexing = false;
  }
}

export async function startBackgroundIndexing(contextLength: number): Promise<void> {
  const files = scanVault();
  const fsPaths = new Set(files.map((f) => path.relative(config.vaultPath, f).normalize('NFD')));
  cleanupStaleNotes(fsPaths);
  _totalExpected = files.length;
  _processedCount = 0;
  _indexQueue.push(...files);
  processQueue(contextLength).catch((err) => {
    console.warn('[indexer] background indexing error:', err);
  });
}

const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function startWatcher(contextLength: number): void {
  // Lazy import to avoid loading chokidar at startup
  import('chokidar')
    .then(({ watch }) => {
      const watcher = watch(config.vaultPath, {
        ignored: (filePath: string) => {
          const base = path.basename(filePath);
          // Allow directories
          try {
            if (statSync(filePath).isDirectory()) {
              const rel = path.relative(config.vaultPath, filePath);
              return isIgnored(rel + '/');
            }
          } catch {
            return true;
          }
          if (!base.endsWith('.md')) return true;
          const rel = path.relative(config.vaultPath, filePath);
          return isIgnored(rel);
        },
        persistent: true,
        ignoreInitial: true,
      });

      const handleChange = (filePath: string) => {
        const existing = debounceTimers.get(filePath);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
          debounceTimers.delete(filePath);
          indexFile(filePath, contextLength).catch((err) => {
            console.warn('[watcher] error indexing', filePath, err);
          });
        }, config.debounce);
        debounceTimers.set(filePath, timer);
      };

      watcher.on('add', handleChange);
      watcher.on('change', handleChange);
      watcher.on('unlink', (filePath: string) => {
        const rel = path.relative(config.vaultPath, filePath).normalize('NFD');
        deleteNote(rel);
        bumpIndexVersion();
      });
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
  for (const match of content.matchAll(/\[\[([^\]|#]+?)(?:[|#][^\]]*)?\]\]/g)) {
    const target = match[1]!.trim();
    if (target) seen.add(target);
  }
  return [...seen];
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
