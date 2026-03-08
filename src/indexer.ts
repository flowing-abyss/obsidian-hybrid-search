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

interface IndexResult {
  indexed: number;
  skipped: number;
  errors: Array<{ path: string; error: string }>;
}

function matchesIgnorePattern(relPath: string, pattern: string): boolean {
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    return (
      relPath === prefix ||
      relPath.startsWith(prefix + path.sep) ||
      relPath.startsWith(prefix + '/')
    );
  }
  if (pattern.startsWith('*.')) {
    const ext = pattern.slice(1);
    return relPath.endsWith(ext) || path.basename(relPath).endsWith(ext);
  }
  return relPath === pattern || relPath.startsWith(pattern + '/');
}

export function isIgnored(relPath: string): boolean {
  return config.ignorePatterns.some((p) => matchesIgnorePattern(relPath, p.trim()));
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

    const { data: frontmatter, content } = matter(raw);
    const title = (frontmatter.title as string | undefined) ?? path.basename(fullPath, '.md');
    const frontmatterTags: string[] = Array.isArray(frontmatter.tags)
      ? frontmatter.tags.map(String)
      : typeof frontmatter.tags === 'string'
        ? frontmatter.tags.split(',').map((t: string) => t.trim())
        : [];
    const inlineTags = parseInlineTags(content);
    const tags = [...new Set([...frontmatterTags, ...inlineTags])];
    const aliases: string[] = Array.isArray(frontmatter.aliases)
      ? frontmatter.aliases.map(String).filter(Boolean)
      : typeof frontmatter.aliases === 'string' && frontmatter.aliases.trim()
        ? [frontmatter.aliases.trim()]
        : [];

    const ctxLen = contextLength ?? (await getContextLength());
    const chunks = chunkNote(content, ctxLen).filter((c) => c.text.trim().length > 0);

    if (chunks.length === 0) {
      return 'skipped';
    }

    // Prepend title to first chunk — improves semantic recall for the note as a whole
    // (idea from obsidian-similar-notes plugin)
    const textsToEmbed = chunks.map((c, i) => (i === 0 && title ? `${title}\n${c.text}` : c.text));
    const embeddings = await embed(textsToEmbed);

    upsertNote({
      path: relPath,
      title,
      tags,
      aliases,
      content,
      mtime: stat.mtimeMs,
      hash,
      chunks: chunks.map((c, i) => ({ text: c.text, embedding: embeddings[i]! })),
    });

    const resolvedLinks = resolveWikilinks(content, relPath);
    upsertLinks(relPath, resolvedLinks);

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

  const notes = db.prepare('SELECT path, content FROM notes WHERE content IS NOT NULL').all() as {
    path: string;
    content: string;
  }[];
  for (const note of notes) {
    const links = resolveWikilinks(note.content, note.path);
    upsertLinks(note.path, links);
  }

  db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES('links_v1', '1')").run();
}

/**
 * Remove notes that no longer belong in the index:
 * - notes matching updated ignore patterns
 * - notes whose files were deleted from disk
 * Called on server startup and during full reindex.
 */
function cleanupStaleNotes(fsPaths?: Set<string>): void {
  // Newly ignored notes: file still exists on disk, keep their link entries
  // so backlinks from ignored notes remain visible in search results
  const pathsToRemove = getPathsToRemoveForIgnoreChange(config.ignorePatterns);
  for (const p of pathsToRemove) {
    if (isIgnored(p)) deleteNote(p, true); // keepLinks=true
  }

  // Notes deleted from filesystem: remove everything including links (broken links)
  if (fsPaths) {
    const db = getDb();
    const dbPaths = (db.prepare('SELECT path FROM notes').all() as { path: string }[]).map(
      (r) => r.path,
    );
    for (const dbPath of dbPaths) {
      if (!fsPaths.has(dbPath)) deleteNote(dbPath); // keepLinks=false
    }
  }
}

export async function indexVaultSync(force = false): Promise<IndexResult> {
  const files = scanVault();
  const fsPaths = new Set(files.map((f) => path.relative(config.vaultPath, f).normalize('NFD')));
  cleanupStaleNotes(fsPaths);

  const contextLength = await getContextLength();
  const result: IndexResult = { indexed: 0, skipped: 0, errors: [] };

  const logInterval = Math.max(50, Math.floor(files.length / 10));
  for (let i = 0; i < files.length; i += config.batchSize) {
    if (i > 0 && i % logInterval === 0) {
      console.error(
        `[indexer] ${i}/${files.length} files processed (${result.indexed} indexed, ${result.errors.length} errors)`,
      );
    }
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
  }

  await populateMissingLinks();
  updateLastIndexed();
  return result;
}

const _indexQueue: string[] = [];
let _isIndexing = false;

async function processQueue(contextLength: number): Promise<void> {
  if (_isIndexing) return;
  _isIndexing = true;
  try {
    while (_indexQueue.length > 0) {
      const batch = _indexQueue.splice(0, config.batchSize);
      await Promise.all(batch.map((f) => indexFile(f, contextLength)));
    }
    updateLastIndexed();
  } finally {
    _isIndexing = false;
  }
}

export async function startBackgroundIndexing(contextLength: number): Promise<void> {
  const files = scanVault();
  const fsPaths = new Set(files.map((f) => path.relative(config.vaultPath, f).normalize('NFD')));
  cleanupStaleNotes(fsPaths);
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

function parseWikilinks(content: string): string[] {
  const seen = new Set<string>();
  for (const match of content.matchAll(/\[\[([^\]|#]+?)(?:[|#][^\]]*)?\]\]/g)) {
    const target = match[1]!.trim();
    if (target) seen.add(target);
  }
  return [...seen];
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- wikilink resolution requires O(N) alias/title lookups
function resolveWikilinks(content: string, fromPath: string): string[] {
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
  const titleMap = new Map(allNotes.map((n) => [n.title.toLowerCase(), n.path]));
  // basename map: 'note.md' → 'folder/sub/note.md' (first match wins)
  const basenameMap = new Map<string, string>();
  // alias map: 'alias text' → note path
  const aliasMap = new Map<string, string>();
  for (const n of allNotes) {
    const base = path.basename(n.path);
    if (!basenameMap.has(base)) basenameMap.set(base, n.path);
    if (n.aliases) {
      try {
        const aliases = JSON.parse(n.aliases) as string[];
        for (const alias of aliases) {
          if (alias && !aliasMap.has(alias.toLowerCase())) {
            aliasMap.set(alias.toLowerCase(), n.path);
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

    // 1. Exact path match
    if (pathSet.has(withMd) && withMd !== fromPath) {
      resolved.push(withMd);
      continue;
    }

    // 2. Basename match (wikilink without folder prefix)
    const byBasename = basenameMap.get(base);
    if (byBasename && byBasename !== fromPath) {
      resolved.push(byBasename);
      continue;
    }

    // 3. Alias match (case-insensitive)
    const byAlias = aliasMap.get(target.toLowerCase());
    if (byAlias && byAlias !== fromPath) {
      resolved.push(byAlias);
      continue;
    }

    // 4. Title match (case-insensitive)
    const byTitle = titleMap.get(target.toLowerCase());
    if (byTitle && byTitle !== fromPath) {
      resolved.push(byTitle);
    }
  }

  return [...new Set(resolved)];
}
