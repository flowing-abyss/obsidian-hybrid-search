import path from 'node:path';
import { getDb, getLinksForPaths, getNoteByPath, hasVecTable } from './db.js';
import { embed } from './embedder.js';

interface SearchResult {
  path: string;
  title: string;
  tags: string[];
  score: number;
  depth?: number; // only present in related mode (negative = backlink direction)
  snippet: string;
  matchedBy: string[];
  links: string[];
  backlinks: string[];
  scores: {
    semantic: number | null;
    bm25: number | null;
    fuzzy_title: number | null;
  };
}

interface SearchOptions {
  mode?: 'hybrid' | 'semantic' | 'fulltext' | 'title';
  scope?: string | string[];
  limit?: number;
  threshold?: number;
  tag?: string | string[];
  related?: boolean;
  depth?: number;
  direction?: 'outgoing' | 'backlinks' | 'both';
  snippetLength?: number;
  /** Explicit note path for similarity/related lookup — overrides the input heuristic */
  notePath?: string;
}

interface RawResult {
  path: string;
  title: string;
  tags: string;
  snippet: string;
  score: number;
  scores: {
    semantic?: number;
    bm25?: number;
    fuzzy_title?: number;
  };
}

function matchesScopeFilter(notePath: string, scope: string | string[]): boolean {
  const scopes = (Array.isArray(scope) ? scope : [scope]).map((s) => s.normalize('NFD'));
  const includes = scopes.filter((s) => !s.startsWith('-'));
  const excludes = scopes.filter((s) => s.startsWith('-')).map((s) => s.slice(1));
  if (excludes.some((ex) => notePath.startsWith(ex))) return false;
  if (includes.length === 0) return true;
  return includes.some((inc) => notePath.startsWith(inc));
}

function applyScope(results: RawResult[], scope?: string | string[]): RawResult[] {
  if (!scope) return results;
  return results.filter((r) => matchesScopeFilter(r.path, scope));
}

function applyThreshold(results: RawResult[], threshold: number): RawResult[] {
  return results.filter((r) => r.score >= threshold);
}

function matchesTagFilter(tags: string[], tag: string | string[]): boolean {
  const filters = Array.isArray(tag) ? tag : [tag];
  const includes = filters.filter((t) => !t.startsWith('-')).map((t) => t.toLowerCase());
  const excludes = filters.filter((t) => t.startsWith('-')).map((t) => t.slice(1).toLowerCase());
  const lowerTags = tags.map((t) => t.toLowerCase());
  if (excludes.some((ex) => lowerTags.some((t) => t === ex || t.includes(ex)))) return false;
  if (includes.length === 0) return true;
  return includes.some((inc) => lowerTags.some((t) => t === inc || t.includes(inc)));
}

function applyTagFilter(results: RawResult[], tag: string | string[]): RawResult[] {
  return results.filter((r) => {
    try {
      const tags = JSON.parse(r.tags || '[]') as string[];
      return matchesTagFilter(tags, tag);
    } catch {
      return false;
    }
  });
}

function toSearchResult(r: RawResult): SearchResult {
  let tags: string[];
  try {
    tags = JSON.parse(r.tags || '[]') as string[];
  } catch {
    tags = [];
  }
  const matchedBy: string[] = [];
  if (r.scores.semantic != null) matchedBy.push('semantic');
  if (r.scores.bm25 != null) matchedBy.push('bm25');
  if (r.scores.fuzzy_title != null) matchedBy.push('title');
  return {
    ...r,
    tags,
    matchedBy,
    links: [],
    backlinks: [],
    scores: {
      semantic: r.scores.semantic ?? null,
      bm25: r.scores.bm25 ?? null,
      fuzzy_title: r.scores.fuzzy_title ?? null,
    },
  };
}

function sanitizeFtsQuery(query: string): string {
  return query.replace(/["*^]/g, ' ').trim();
}

function toFtsQuery(query: string): string {
  const clean = sanitizeFtsQuery(query);
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length === 0) return '""';
  return words.map((w) => `"${w}"*`).join(' OR ');
}

export function searchBm25(query: string, limit: number): RawResult[] {
  const db = getDb();
  const ftsQuery = toFtsQuery(query);

  try {
    const rows = db
      .prepare(
        `
      SELECT n.path, n.title, n.tags,
             snippet(notes_fts_bm25, 1, '', '', '...', 40) AS snippet,
             bm25(notes_fts_bm25) AS rank
      FROM notes_fts_bm25
      JOIN notes n ON n.id = notes_fts_bm25.rowid
      WHERE notes_fts_bm25 MATCH ?
      ORDER BY rank
      LIMIT ?
    `,
      )
      .all(ftsQuery, limit) as Array<{
      path: string;
      title: string;
      tags: string;
      snippet: string;
      rank: number;
    }>;

    return rows.map((row) => ({
      path: row.path,
      title: row.title ?? '',
      tags: row.tags ?? '[]',
      snippet: row.snippet ?? '',
      score: Math.max(0, Math.abs(row.rank) / (1 + Math.abs(row.rank))),
      scores: {
        bm25: Math.max(0, Math.abs(row.rank) / (1 + Math.abs(row.rank))),
      },
    }));
  } catch {
    return [];
  }
}

function buildTrigramOrQuery(text: string): string {
  if (text.length < 3) return `"${text.replace(/"/g, '')}"`;
  const trigrams: string[] = [];
  for (let i = 0; i <= text.length - 3; i++) {
    trigrams.push(`"${text.slice(i, i + 3).replace(/"/g, '')}"`);
  }
  return trigrams.join(' OR ');
}

export function searchFuzzyTitle(query: string, limit: number): RawResult[] {
  const db = getDb();
  const ftsQuery = buildTrigramOrQuery(query);

  try {
    const rows = db
      .prepare(
        `
      SELECT n.path, n.title, n.tags,
             bm25(notes_fts_fuzzy) AS rank
      FROM notes_fts_fuzzy
      JOIN notes n ON n.id = notes_fts_fuzzy.rowid
      WHERE notes_fts_fuzzy MATCH ?
      ORDER BY rank
      LIMIT ?
    `,
      )
      .all(ftsQuery, limit) as Array<{
      path: string;
      title: string;
      tags: string;
      rank: number;
    }>;

    return rows.map((row) => ({
      path: row.path,
      title: row.title ?? '',
      tags: row.tags ?? '[]',
      snippet: '',
      score: Math.max(0, Math.abs(row.rank) / (1 + Math.abs(row.rank))),
      scores: {
        fuzzy_title: Math.max(0, Math.abs(row.rank) / (1 + Math.abs(row.rank))),
      },
    }));
  } catch {
    return [];
  }
}

async function searchVector(queryEmbedding: Float32Array, limit: number): Promise<RawResult[]> {
  if (!hasVecTable()) return [];

  const db = getDb();

  try {
    const rows = db
      .prepare(
        `
      SELECT vc.chunk_id, vc.distance,
             c.note_id, c.chunk_index, c.text AS chunk_text,
             n.path, n.title, n.tags
      FROM vec_chunks AS vc
      JOIN chunks c ON c.id = vc.chunk_id
      JOIN notes n ON n.id = c.note_id
      WHERE vc.embedding MATCH ?
        AND k = ?
    `,
      )
      .all(queryEmbedding, limit * 5) as Array<{
      chunk_id: number;
      distance: number;
      note_id: number;
      chunk_index: number;
      chunk_text: string;
      path: string;
      title: string;
      tags: string;
    }>;

    // Aggregate: best chunk per note
    const noteMap = new Map<number, { distance: number; row: (typeof rows)[0] }>();
    for (const row of rows) {
      const existing = noteMap.get(row.note_id);
      if (!existing || row.distance < existing.distance) {
        noteMap.set(row.note_id, { distance: row.distance, row });
      }
    }

    return Array.from(noteMap.values())
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit)
      .map(({ distance, row }) => {
        // L2 distance for unit vectors: 0 = identical, 2 = opposite
        const similarity = Math.max(0, 1 - distance / 2);
        return {
          path: row.path,
          title: row.title ?? '',
          tags: row.tags ?? '[]',
          snippet: row.chunk_index > 0 ? '...' + row.chunk_text : row.chunk_text,
          score: similarity,
          scores: { semantic: similarity },
        };
      });
  } catch {
    return [];
  }
}

function rrfFusion(lists: RawResult[][], k = 60): RawResult[] {
  const scores = new Map<string, { rrfScore: number; result: RawResult }>();

  for (const list of lists) {
    list.forEach((result, rank) => {
      const rrfScore = 1 / (k + rank + 1);
      const existing = scores.get(result.path);
      if (existing) {
        existing.rrfScore += rrfScore;
        // Merge score details, prefer semantic snippet
        if (result.scores.semantic !== undefined) {
          existing.result.snippet = result.snippet;
          existing.result.scores.semantic = result.scores.semantic;
        }
        if (result.scores.bm25 !== undefined) {
          existing.result.scores.bm25 = result.scores.bm25;
          if (!existing.result.scores.semantic) existing.result.snippet = result.snippet;
        }
        if (result.scores.fuzzy_title !== undefined) {
          existing.result.scores.fuzzy_title = result.scores.fuzzy_title;
        }
      } else {
        scores.set(result.path, {
          rrfScore,
          result: { ...result, scores: { ...result.scores } },
        });
      }
    });
  }

  const maxPossibleScore = lists.length / (k + 1);

  return Array.from(scores.values())
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .map(({ rrfScore, result }) => ({
      ...result,
      score: rrfScore / maxPossibleScore,
    }));
}

// ─── Graph traversal ─────────────────────────────────────

/** Get the first maxChars characters of a note's content as a fallback snippet. */
function getSnippetFallback(notePath: string, maxChars: number): string {
  const db = getDb();
  const note = db.prepare('SELECT content FROM notes WHERE path = ?').get(notePath) as
    | { content: string }
    | undefined;
  if (!note?.content) return '';
  return note.content.slice(0, maxChars).trim();
}

/**
 * Extract the sentence/line context around a wikilink [[target]] inside a note.
 * contentNotePath: the note whose content we search in
 * linkedNotePath:  the target note we're looking for a link to
 */
function getLinkContext(contentNotePath: string, linkedNotePath: string, windowSize = 300): string {
  const db = getDb();
  const note = db.prepare('SELECT content FROM notes WHERE path = ?').get(contentNotePath) as
    | { content: string }
    | undefined;
  if (!note?.content) return '';

  const basename = path.basename(linkedNotePath, '.md');
  // Match [[basename]], [[basename|alias]], [[basename#heading]], [[folder/basename]], etc.
  const escaped = basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`\\[\\[(?:[^\\]|#]*\\/)?${escaped}(?:[|#][^\\]]*)?\\]\\]`, 'i');

  const match = regex.exec(note.content);
  if (!match) return '';

  let start = Math.max(0, match.index - windowSize);
  let end = Math.min(note.content.length, match.index + match[0].length + windowSize);

  // Snap to word boundaries so we don't cut mid-word
  if (start > 0) {
    while (start < match.index && !/\s/.test(note.content[start]!)) start++;
  }
  if (end < note.content.length) {
    while (end > match.index + match[0].length && !/\s/.test(note.content[end - 1]!)) end--;
  }

  const prefix = start > 0 ? '...' : '';
  const suffix = end < note.content.length ? '...' : '';
  // Preserve newlines so CLI can strip line-based markdown (headings, blockquotes)
  return prefix + note.content.slice(start, end).trim() + suffix;
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- primary search aggregation pipeline, intentionally dense
function searchRelated(
  notePath: string,
  maxDepth: number,
  direction: 'outgoing' | 'backlinks' | 'both' = 'both',
  snippetLength = 300,
): SearchResult[] {
  const db = getDb();
  const sourcePath = notePath.normalize('NFD');
  const results: SearchResult[] = [];

  const makeResult = (notePth: string, depth: number, snippet: string): SearchResult | null => {
    const note = db.prepare('SELECT path, title, tags FROM notes WHERE path = ?').get(notePth) as
      | { path: string; title: string; tags: string }
      | undefined;
    if (!note) return null;
    let tags: string[];
    try {
      tags = JSON.parse(note.tags || '[]') as string[];
    } catch {
      tags = [];
    }
    return {
      path: note.path,
      title: note.title ?? '',
      tags,
      score: 1 / (1 + Math.abs(depth)),
      depth,
      snippet,
      matchedBy: [],
      links: [],
      backlinks: [],
      scores: { semantic: null, bm25: null, fuzzy_title: null },
    };
  };

  // Source note at depth 0
  const source = makeResult(sourcePath, 0, '');
  if (!source) return [];
  results.push(source);

  // Forward BFS — follow outgoing links (+depth)
  if (direction === 'outgoing' || direction === 'both') {
    const visitedFwd = new Set<string>([sourcePath]);
    let frontier = [sourcePath];
    for (let d = 1; d <= maxDepth; d++) {
      const next: string[] = [];
      for (const parentPath of frontier) {
        const links = db
          .prepare('SELECT to_path FROM links WHERE from_path = ?')
          .all(parentPath) as { to_path: string }[];
        for (const { to_path } of links) {
          if (!visitedFwd.has(to_path)) {
            visitedFwd.add(to_path);
            const snippet = getLinkContext(parentPath, to_path, snippetLength);
            const r = makeResult(to_path, d, snippet);
            if (r) results.push(r);
            next.push(to_path);
          }
        }
      }
      frontier = next;
      if (frontier.length === 0) break;
    }
  }

  // Backward BFS — follow backlinks (-depth)
  if (direction === 'backlinks' || direction === 'both') {
    const visitedBwd = new Set<string>([sourcePath]);
    let frontier = [sourcePath];
    for (let d = 1; d <= maxDepth; d++) {
      const next: string[] = [];
      for (const parentPath of frontier) {
        const backlinks = db
          .prepare('SELECT from_path FROM links WHERE to_path = ?')
          .all(parentPath) as { from_path: string }[];
        for (const { from_path } of backlinks) {
          if (!visitedBwd.has(from_path)) {
            visitedBwd.add(from_path);
            const snippet = getLinkContext(from_path, parentPath, snippetLength);
            const r = makeResult(from_path, -d, snippet);
            if (r) results.push(r);
            next.push(from_path);
          }
        }
      }
      frontier = next;
      if (frontier.length === 0) break;
    }
  }

  // Sort: -N ... -1, 0, +1 ... +N
  results.sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0));

  // Populate links/backlinks for all results
  const paths = results.map((r) => r.path);
  const { links, backlinks } = getLinksForPaths(paths);
  for (const r of results) {
    r.links = links.get(r.path) ?? [];
    r.backlinks = backlinks.get(r.path) ?? [];
  }

  return results;
}

// ─── LRU cache ───────────────────────────────────────────
// Avoids redundant searches when the same query is repeated (common in MCP usage).
// Path-based lookups are cached by path:mtime so stale entries auto-invalidate.

class LRUCache<V> {
  private map = new Map<string, V>();
  constructor(private maxSize: number) {}

  get(key: string): V | undefined {
    const val = this.map.get(key);
    if (val !== undefined) {
      this.map.delete(key);
      this.map.set(key, val);
    }
    return val;
  }

  set(key: string, val: V): void {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.maxSize) this.map.delete(this.map.keys().next().value!);
    this.map.set(key, val);
  }
}

const searchCache = new LRUCache<SearchResult[]>(20);

function cacheKey(input: string, options: SearchOptions): string {
  const scopeStr = Array.isArray(options.scope) ? options.scope.join(',') : (options.scope ?? '');
  const tagStr = Array.isArray(options.tag) ? options.tag.join(',') : (options.tag ?? '');
  return `${input}\0${options.mode ?? ''}\0${scopeStr}\0${options.limit ?? ''}\0${options.threshold ?? ''}\0${tagStr}\0${options.snippetLength ?? ''}\0${options.notePath ?? ''}`;
}

export async function search(input: string, options: SearchOptions = {}): Promise<SearchResult[]> {
  const mode = options.mode ?? 'hybrid';
  const limit = options.limit ?? 10;
  const threshold = options.threshold ?? 0.0;
  const snippetLength = options.snippetLength ?? 300;

  // Explicit notePath overrides heuristic; legacy: detect by shape of input string
  const isPathLookup =
    options.notePath !== undefined || input.includes('/') || input.endsWith('.md');
  const resolvedPath = options.notePath ?? input;

  // Related mode: graph traversal, skip the normal search pipeline
  if (isPathLookup && options.related) {
    const maxDepth = options.depth ?? 1;
    const direction = options.direction ?? 'both';
    const scopeStr = Array.isArray(options.scope) ? options.scope.join(',') : (options.scope ?? '');
    const tagStr = Array.isArray(options.tag) ? options.tag.join(',') : (options.tag ?? '');
    const key = `related\0${resolvedPath}\0${maxDepth}\0${direction}\0${snippetLength}\0${scopeStr}\0${tagStr}`;
    const cached = searchCache.get(key);
    if (cached) return cached;
    let related = searchRelated(resolvedPath, maxDepth, direction, snippetLength);
    // Apply scope and tag filters (related bypasses the normal pipeline)
    if (options.scope) related = related.filter((r) => matchesScopeFilter(r.path, options.scope!));
    if (options.tag && (!Array.isArray(options.tag) || options.tag.length > 0)) {
      related = related.filter((r) => matchesTagFilter(r.tags, options.tag!));
    }
    // Snippet fallback for results with empty snippets; cap all to snippetLength
    for (const r of related) {
      if (!r.snippet) r.snippet = getSnippetFallback(r.path, snippetLength);
      if (r.snippet.length > snippetLength) r.snippet = r.snippet.slice(0, snippetLength);
    }
    searchCache.set(key, related);
    return related;
  }

  // For path lookups, include mtime in cache key so stale entries auto-invalidate
  let key = cacheKey(resolvedPath, options);
  if (isPathLookup) {
    const note = getNoteByPath(resolvedPath.normalize('NFD'));
    if (note) key += `\0${note.mtime}`;
  }
  const cached = searchCache.get(key);
  if (cached) return cached;

  let results: RawResult[];

  if (isPathLookup) {
    results = await searchSimilar(resolvedPath, limit);
  } else {
    results = await searchByQuery(input, mode, limit);
  }

  results = applyScope(results, options.scope);
  results = applyThreshold(results, threshold);
  if (options.tag && (!Array.isArray(options.tag) || options.tag.length > 0)) {
    results = applyTagFilter(results, options.tag);
  }
  results = results.slice(0, limit);

  const paths = results.map((r) => r.path);
  const { links, backlinks } = getLinksForPaths(paths);

  const final = results.map((r) => {
    const sr = toSearchResult(r);
    if (!sr.snippet) sr.snippet = getSnippetFallback(sr.path, snippetLength);
    if (sr.snippet.length > snippetLength) sr.snippet = sr.snippet.slice(0, snippetLength);
    return {
      ...sr,
      links: links.get(sr.path) ?? [],
      backlinks: backlinks.get(sr.path) ?? [],
    };
  });
  searchCache.set(key, final);
  return final;
}

async function searchByQuery(query: string, mode: string, limit: number): Promise<RawResult[]> {
  if (mode === 'fulltext') {
    return searchBm25(query, limit);
  }

  if (mode === 'title') {
    return searchFuzzyTitle(query, limit);
  }

  if (mode === 'semantic') {
    const [embedding] = await embed([query]);
    return searchVector(new Float32Array(embedding!), limit);
  }

  // hybrid: RRF fusion of all three
  const [embedding] = await embed([query]);
  const [bm25Results, fuzzyResults, vectorResults] = await Promise.all([
    Promise.resolve(searchBm25(query, limit)),
    Promise.resolve(searchFuzzyTitle(query, limit)),
    searchVector(new Float32Array(embedding!), limit),
  ]);

  return rrfFusion([vectorResults, bm25Results, fuzzyResults]);
}

async function searchSimilar(notePath: string, limit: number): Promise<RawResult[]> {
  // macOS stores filenames as NFD; normalize to match DB paths
  const note = getNoteByPath(notePath.normalize('NFD'));
  if (!note) return [];

  // Embed a representative portion of the note
  const textToEmbed = note.content.slice(0, 2000);
  const [embedding] = await embed([textToEmbed]);
  const results = await searchVector(new Float32Array(embedding!), limit + 1);

  // Exclude the source note
  return results.filter((r) => r.path !== notePath).slice(0, limit);
}
