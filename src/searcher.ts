import path from 'node:path';
import { config } from './config.js';
import {
  getBacklinksForPaths,
  getChunkEmbeddingsByPath,
  getDb,
  getDbVersion,
  getLinksForPaths,
  getNoteByPath,
  getOutgoingLinks,
  getOutgoingLinksForPaths,
  hasVecTable,
} from './db.js';
import { embed } from './embedder.js';
import { reranker, type RerankCandidate } from './reranker.js';

export interface NoteReadResult {
  path: string;
  found: true;
  title: string;
  aliases: string[];
  tags: string[];
  content: string;
  links: string[];
  backlinks: string[];
}

export interface NoteReadMiss {
  path: string;
  found: false;
  suggestions: string[];
}

export type ReadResult = NoteReadResult | NoteReadMiss;

export interface SearchResult {
  path: string;
  title: string;
  tags: string[];
  aliases: string[];
  score: number;
  rank?: number; // 1-based position in the result set (populated by search())
  depth?: number; // only present in related mode (negative = backlink direction)
  snippet: string;
  matchedBy: string[];
  links: string[];
  backlinks: string[];
  scores: {
    semantic: number | null;
    bm25: number | null;
    fuzzy_title: number | null;
    hybrid: number | null;
  };
}

export interface SearchOptions {
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
  rerank?: boolean;
  /**
   * Multi-query fan-out: run parallel searches for each query and merge via RRF.
   * Use when you have 2–4 reformulations of the same question.
   * Reranking (if enabled) is applied once after all results are merged.
   * When length ≤ 1, falls back to single-query behaviour.
   */
  queries?: string[];
}

interface RawResult {
  path: string;
  title: string;
  tags: string;
  aliases?: string | null;
  snippet: string;
  score: number;
  chunkText?: string; // best chunk text for reranker input
  scores: {
    semantic?: number;
    bm25?: number;
    fuzzy_title?: number;
    hybrid?: number; // RRF score, set when mode='hybrid'
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
  const aliases = parseAliases(r.aliases);
  const matchedBy: string[] = [];
  if (r.scores.semantic != null) matchedBy.push('semantic');
  if (r.scores.bm25 != null) matchedBy.push('bm25');
  if (r.scores.fuzzy_title != null) matchedBy.push('title');
  const { chunkText: _chunkText, ...rest } = r;
  return {
    ...rest,
    tags,
    aliases,
    matchedBy,
    links: [],
    backlinks: [],
    scores: {
      semantic: r.scores.semantic ?? null,
      bm25: r.scores.bm25 ?? null,
      fuzzy_title: r.scores.fuzzy_title ?? null,
      hybrid: r.scores.hybrid ?? null,
    },
  };
}

function parseAliases(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

function sanitizeFtsQuery(query: string): string {
  return query
    .replace(/["*^()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toFtsQuery(query: string, operator: 'AND' | 'OR' = 'AND'): string {
  const clean = sanitizeFtsQuery(query);
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length === 0) return '""';
  return words.map((w) => `"${w}"*`).join(` ${operator} `);
}

type FtsRow = {
  path: string;
  title: string;
  tags: string;
  aliases: string | null;
  snippet: string;
  rank: number;
};

export function searchBm25(query: string, limit: number, snippetLength = 300): RawResult[] {
  const db = getDb();
  const numTokens = Math.max(10, Math.ceil(snippetLength / 4));
  const stmt = db.prepare<[number, string, number], FtsRow>(
    `
      SELECT n.path, n.title, n.tags, n.aliases,
             snippet(notes_fts_bm25, 2, '', '', '...', ?) AS snippet,
             bm25(notes_fts_bm25, 10.0, 5.0, 1.0) AS rank
      FROM notes_fts_bm25
      JOIN notes n ON n.id = notes_fts_bm25.rowid
      WHERE notes_fts_bm25 MATCH ?
      ORDER BY rank
      LIMIT ?
    `,
  );

  try {
    // Use OR so that documents are ranked by how many query terms they match (BM25
    // naturally scores full-match documents higher).  AND was filtering out
    // relevant documents whenever a single query word (e.g. "between", "organize")
    // was absent from the document—even if that document was the best conceptual
    // match for every other term in the query.
    const rows = stmt.all(numTokens, toFtsQuery(query, 'OR'), limit);

    const results = rows.map((row) => ({
      path: row.path,
      title: row.title ?? '',
      tags: row.tags ?? '[]',
      aliases: row.aliases,
      snippet: row.snippet ?? '',
      score: Math.max(0, Math.abs(row.rank) / (1 + Math.abs(row.rank))),
      scores: {
        bm25: Math.max(0, Math.abs(row.rank) / (1 + Math.abs(row.rank))),
      },
    }));
    // Enrich BM25 snippets with heading breadcrumb from the chunks table.
    // Skip when snippetLength=0 (e.g. Obsidian plugin): the snippet would be
    // discarded anyway and the DB lookups (2 per result) are wasted work.
    if (snippetLength > 0) {
      for (const result of results) {
        const headingPath = getHeadingPathForSnippet(result.path, result.snippet);
        if (headingPath) result.snippet = `${headingPath}\n${result.snippet}`;
      }
    }
    return results;
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

function getTrigrams(text: string): Set<string> {
  const trigrams = new Set<string>();
  if (text.length < 3) {
    trigrams.add(text.toLowerCase());
    return trigrams;
  }
  for (let i = 0; i <= text.length - 3; i++) {
    trigrams.add(text.slice(i, i + 3).toLowerCase());
  }
  return trigrams;
}

function calculateTrigramOverlap(query: string, title: string): number {
  const queryTrigrams = getTrigrams(query);
  if (queryTrigrams.size === 0) return 0;

  const titleTrigrams = getTrigrams(title);
  let matchCount = 0;
  for (const t of queryTrigrams) {
    if (titleTrigrams.has(t)) matchCount++;
  }

  return matchCount / queryTrigrams.size;
}

/**
 * Exact alias match using JS-level Unicode case-folding (NFD + toLowerCase).
 * Handles short aliases (< 3 chars) that the trigram FTS index can't tokenize,
 * and Cyrillic / non-ASCII aliases that SQLite's lower() doesn't fold correctly.
 */
function searchByAliasExact(query: string, limit: number): RawResult[] {
  const db = getDb();
  const queryNfd = query.normalize('NFD').toLowerCase();

  const rows = db
    .prepare(
      "SELECT path, title, tags, aliases FROM notes WHERE aliases IS NOT NULL AND aliases != '[]'",
    )
    .all() as Array<{ path: string; title: string; tags: string; aliases: string }>;

  const matches: RawResult[] = [];
  for (const row of rows) {
    if (matches.length >= limit) break;
    if (parseAliases(row.aliases).some((a) => a.normalize('NFD').toLowerCase() === queryNfd)) {
      matches.push({
        path: row.path,
        title: row.title ?? '',
        tags: row.tags ?? '[]',
        aliases: row.aliases,
        snippet: '',
        score: 1.0,
        scores: { fuzzy_title: 1.0 },
      });
    }
  }
  return matches;
}

export function searchFuzzyTitle(query: string, limit: number): RawResult[] {
  // Exact alias match first — handles short aliases (< 3 chars) and Cyrillic that
  // the trigram FTS can't tokenize, ensuring they always surface in title/hybrid mode.
  const aliasExact = searchByAliasExact(query, limit);
  const aliasExactPaths = new Set(aliasExact.map((r) => r.path));

  const db = getDb();
  const ftsQuery = buildTrigramOrQuery(query);

  try {
    const ftsRows = db
      .prepare(
        `
      SELECT n.path, n.title, n.tags, n.aliases,
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
      aliases: string | null;
      rank: number;
    }>;

    const trigramResults = ftsRows
      .map((row) => {
        const titleOverlap = calculateTrigramOverlap(query, row.title ?? '');
        // Only consider aliases with ≥3 chars — shorter strings produce no trigrams
        // in the FTS index and would always give overlap=0 anyway.
        const aliasOverlap = parseAliases(row.aliases)
          .filter((a) => a.length >= 3)
          .reduce((max, a) => Math.max(max, calculateTrigramOverlap(query, a)), 0);
        const overlap = Math.max(titleOverlap, aliasOverlap);
        const baseScore = Math.max(0, Math.abs(row.rank) / (1 + Math.abs(row.rank)));
        const adjustedScore = baseScore * overlap * overlap;

        return {
          path: row.path,
          title: row.title ?? '',
          tags: row.tags ?? '[]',
          aliases: row.aliases,
          snippet: '',
          score: adjustedScore,
          scores: {
            fuzzy_title: adjustedScore,
          },
        };
      })
      .filter((r) => r.score > 0 && !aliasExactPaths.has(r.path));

    // Alias exact matches at the front, trigram results appended (deduped)
    return [...aliasExact, ...trigramResults].slice(0, limit);
  } catch {
    return [...aliasExact];
  }
}

/**
 * Embed a search query. Returns null if embedding failed (already retried internally).
 */
async function embedQuery(text: string): Promise<Float32Array | null> {
  const [emb] = await embed([text], 'query');
  if (emb) return emb;
  // null = embedding failed (already retried internally)
  return null;
}

/**
 * Format a chunk snippet with optional heading breadcrumb.
 * Strips the leading heading line from chunk text to avoid repeating what's in headingPath.
 */
function formatChunkSnippet(
  headingPath: string | null,
  chunkText: string,
  isNonFirst: boolean,
): string {
  const continuationPrefix = isNonFirst ? '...' : '';
  if (!headingPath) return continuationPrefix + chunkText;
  // Strip the leading heading line (e.g. "## Section\n") from chunk text — it's already
  // shown in the breadcrumb above, so displaying it again is redundant.
  const body = chunkText.replace(/^#{1,6}\s+[^\n]*\n?/, '');
  return `${headingPath}\n${continuationPrefix}${body}`;
}

/**
 * Look up the heading_path for the section containing the given BM25 snippet text.
 *
 * Strategy 1 — chunk lookup: works when the note was split into section chunks
 * (contextLength < note size). Finds the chunk whose text contains the snippet key.
 *
 * Strategy 2 — content scan fallback: used when the entire note is stored as one
 * chunk (large-context models like OpenAI text-embedding-3-small fit whole notes).
 * Finds the snippet position in notes.content, then walks backwards to build the
 * heading chain from surrounding headings.
 */
function getHeadingPathForSnippet(notePath: string, snippetText: string): string | null {
  const db = getDb();
  const clean = snippetText
    .replace(/^\.\.\./, '')
    .replace(/\.\.\.$/, '')
    .trim();
  if (clean.length < 15) return null;
  const key = clean.slice(0, 60);

  // Strategy 1: chunk-based lookup
  try {
    const row = db
      .prepare(
        `SELECT c.heading_path FROM chunks c
         JOIN notes n ON n.id = c.note_id
         WHERE n.path = ? AND instr(c.text, ?) > 0
           AND c.heading_path IS NOT NULL
         ORDER BY c.chunk_index LIMIT 1`,
      )
      .get(notePath, key) as { heading_path: string } | undefined;
    if (row?.heading_path) return row.heading_path;
  } catch {
    // heading_path column may not exist yet (pre-reindex) — fall through to strategy 2
  }

  // Strategy 2: scan note content up to the snippet position
  const note = db.prepare('SELECT content FROM notes WHERE path = ?').get(notePath) as
    | { content: string }
    | undefined;
  if (!note?.content) return null;

  const pos = note.content.indexOf(key);
  if (pos === -1) return null;

  const before = note.content.slice(0, pos);
  const headingSlots: (string | null)[] = [null, null, null, null, null, null];
  for (const line of before.split('\n')) {
    const m = /^(#{1,6})\s+(.+)$/.exec(line.trim());
    if (m) {
      const level = m[1]!.length;
      headingSlots[level - 1] = `${m[1]} ${m[2]}`;
      for (let i = level; i < 6; i++) headingSlots[i] = null;
    }
  }
  const chain = headingSlots.filter((s): s is string => s !== null);
  return chain.length > 0 ? chain.join(' > ') : null;
}

// eslint-disable-next-line @typescript-eslint/require-await
async function searchVector(queryEmbedding: Float32Array, limit: number): Promise<RawResult[]> {
  if (!hasVecTable()) return [];

  const db = getDb();

  try {
    const rows = db
      .prepare(
        `
      SELECT vc.chunk_id, vc.distance,
             c.note_id, c.chunk_index, c.text AS chunk_text, c.heading_path,
             n.path, n.title, n.tags, n.aliases
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
      heading_path: string | null;
      path: string;
      title: string;
      tags: string;
      aliases: string | null;
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
        // cosine similarity from L2 for unit vectors: cos = 1 - L2² / 2
        const similarity = Math.max(0, 1 - (distance * distance) / 2);
        return {
          path: row.path,
          title: row.title ?? '',
          tags: row.tags ?? '[]',
          aliases: row.aliases,
          snippet: formatChunkSnippet(row.heading_path, row.chunk_text, row.chunk_index > 0),
          chunkText: row.chunk_text,
          score: similarity,
          scores: { semantic: similarity },
        };
      });
  } catch {
    return [];
  }
}

function rrfFusion(lists: RawResult[][], k = 60, weights?: number[]): RawResult[] {
  const scores = new Map<string, { rrfScore: number; result: RawResult }>();

  for (const [listIndex, list] of lists.entries()) {
    const w = weights?.[listIndex] ?? 1;
    list.forEach((result, rank) => {
      const rrfScore = w / (k + rank + 1);
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

  const activeLists = lists
    .map((l, i) => ({ list: l, weight: weights?.[i] ?? 1 }))
    .filter(({ list }) => list.length > 0);
  const maxPossibleScore =
    activeLists.length > 0 ? activeLists.reduce((sum, { weight }) => sum + weight, 0) / (k + 1) : 1;

  return Array.from(scores.values())
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .map(({ rrfScore, result }) => ({
      ...result,
      score: Math.min(1, rrfScore / maxPossibleScore),
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
    const note = db
      .prepare('SELECT path, title, tags, aliases FROM notes WHERE path = ?')
      .get(notePth) as
      | { path: string; title: string; tags: string; aliases: string | null }
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
      aliases: parseAliases(note.aliases),
      score: 1 / (1 + Math.abs(depth)),
      depth,
      snippet,
      matchedBy: depth === 0 ? ['source'] : depth > 0 ? ['link'] : ['backlink'],
      links: [],
      backlinks: [],
      scores: { semantic: null, bm25: null, fuzzy_title: null, hybrid: null },
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
      const linksByParent = getOutgoingLinksForPaths(frontier);
      for (const parentPath of frontier) {
        for (const to_path of linksByParent.get(parentPath) ?? []) {
          if (visitedFwd.has(to_path)) continue;
          visitedFwd.add(to_path);
          const snippet = getLinkContext(parentPath, to_path, snippetLength);
          const r = makeResult(to_path, d, snippet);
          if (r) results.push(r);
          next.push(to_path);
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
      const backlinksByParent = getBacklinksForPaths(frontier);
      for (const parentPath of frontier) {
        for (const from_path of backlinksByParent.get(parentPath) ?? []) {
          if (visitedBwd.has(from_path)) continue;
          visitedBwd.add(from_path);
          const snippet = getLinkContext(from_path, parentPath, snippetLength);
          const r = makeResult(from_path, -d, snippet);
          if (r) results.push(r);
          next.push(from_path);
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

const searchCache = new LRUCache<SearchResult[]>(100);

// In-process counter for test isolation: incremented by bumpIndexVersion() so that
// separate test suites sharing the same Node.js process don't get cross-suite cache hits.
let localVersion = 0;

/**
 * Increment the local (in-process) version so that subsequent searches bypass the
 * cache. Used by tests to avoid cross-suite cache pollution. In production code,
 * DB-level versioning (getDbVersion) handles cross-process invalidation automatically.
 */
export function bumpIndexVersion(): void {
  localVersion++;
}

function cacheKey(input: string, options: SearchOptions): string {
  const scopeStr = Array.isArray(options.scope) ? options.scope.join(',') : (options.scope ?? '');
  const tagStr = Array.isArray(options.tag) ? options.tag.join(',') : (options.tag ?? '');
  // Include reranker model so that changing RERANKER_MODEL invalidates the cache
  const rerankStr = options.rerank ? config.rerankerModel : '';
  const queriesStr = options.queries && options.queries.length > 1 ? options.queries.join('|') : '';
  // Two-component version:
  //   getDbVersion() — shared via SQLite settings; any process that modifies the DB
  //                    bumps it, invalidating caches in all other processes.
  //   localVersion   — in-process counter; bumpIndexVersion() for test-suite isolation.
  return `v${getDbVersion()}_${localVersion}\0${input}\0${options.mode ?? ''}\0${scopeStr}\0${options.limit ?? ''}\0${options.threshold ?? ''}\0${tagStr}\0${options.snippetLength ?? ''}\0${options.notePath ?? ''}\0${rerankStr}\0${queriesStr}`;
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- primary search entry-point; complexity is inherent in the multi-mode, multi-filter pipeline
export async function search(input: string, options: SearchOptions = {}): Promise<SearchResult[]> {
  const mode = options.mode ?? 'hybrid';
  const limit = options.limit ?? 10;
  const threshold = options.threshold ?? 0.0;
  const snippetLength = options.snippetLength ?? 300;

  // Path-based lookup when --path is given explicitly, OR when related mode is
  // requested and the input looks like a note path (allows the shorthand
  // `search('note.md', { related: true })` used in tests and the MCP server).
  // We intentionally do NOT apply the heuristic for plain text queries: previously
  // `input.includes('/')` would silently redirect to searchSimilar and ignore --mode,
  // causing `ohs "some/path.md"` and `ohss "some/path.md"` to return identical results.
  const isPathLookup =
    options.notePath !== undefined ||
    (options.related === true && (input.includes('/') || input.endsWith('.md')));
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
    // Expand short snippets up to snippetLength, then cap
    for (const r of related) {
      if (!r.snippet || r.snippet.length < snippetLength) {
        const fallback = getSnippetFallback(r.path, snippetLength);
        if (fallback.length > r.snippet.length) r.snippet = fallback;
      }
      if (r.snippet.length > snippetLength) r.snippet = r.snippet.slice(0, snippetLength);
    }
    related.forEach((r, i) => {
      r.rank = i + 1;
    });
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
  } else if (options.queries && options.queries.length > 1) {
    // Multi-query fan-out: run each query in parallel, merge via RRF, then rerank once.
    // Each sub-search uses a larger candidate pool so RRF has enough signal to rank correctly.
    const candidateLimit = Math.max(limit * 2, 20);
    const perQueryResults = await Promise.all(
      options.queries.map((q) => searchByQuery(q, mode, candidateLimit, snippetLength, false)),
    );
    results = rrfFusion(perQueryResults, 60);
    // Populate scores.hybrid on merged results (mirrors single-query hybrid path)
    for (const r of results) {
      r.scores.hybrid = r.score;
    }
    // Rerank after full merge — only in hybrid mode
    if (options.rerank) {
      if (mode !== 'hybrid') {
        process.stderr.write('Reranking is only supported in hybrid mode. Ignoring --rerank.\n');
      } else {
        results = await applyRerank(results, options.queries[0]!, candidateLimit);
      }
    }
  } else {
    results = await searchByQuery(input, mode, limit, snippetLength, options.rerank ?? false);
  }

  results = applyScope(results, options.scope);
  results = applyThreshold(results, threshold);
  if (options.tag && (!Array.isArray(options.tag) || options.tag.length > 0)) {
    results = applyTagFilter(results, options.tag);
  }
  results = results.slice(0, limit);

  const paths = results.map((r) => r.path);
  const { links, backlinks } = getLinksForPaths(paths);

  const final = results.map((r, i) => {
    const sr = toSearchResult(r);
    if (!sr.snippet || sr.snippet.length < snippetLength) {
      const fallback = getSnippetFallback(sr.path, snippetLength);
      if (fallback.length > sr.snippet.length) sr.snippet = fallback;
    }
    if (sr.snippet.length > snippetLength) sr.snippet = sr.snippet.slice(0, snippetLength);
    return {
      ...sr,
      rank: i + 1,
      links: links.get(sr.path) ?? [],
      backlinks: backlinks.get(sr.path) ?? [],
    };
  });
  searchCache.set(key, final);
  return final;
}

/**
 * For candidates that don't yet have chunkText (BM25/fuzzy results),
 * fetch the first chunk text from the DB. Mutates candidates in place.
 * better-sqlite3 is synchronous — no async needed.
 */
function fetchMissingChunkTexts(candidates: RawResult[]): void {
  const db = getDb();
  const stmt = db.prepare<[string], { text: string }>(
    `SELECT c.text
     FROM chunks c
     JOIN notes n ON n.id = c.note_id
     WHERE n.path = ?
     ORDER BY c.chunk_index
     LIMIT 1`,
  );
  for (const r of candidates) {
    if (r.chunkText) continue;
    const row = stmt.get(r.path);
    if (row) r.chunkText = row.text;
  }
}

/**
 * Apply cross-encoder re-ranking to a candidate list.
 * `query` is used as the reranker prompt (use primary query for multi-query).
 * Mutates nothing — returns a new sorted array.
 */
async function applyRerank(
  results: RawResult[],
  query: string,
  candidateLimit: number,
): Promise<RawResult[]> {
  if (results.length <= 1) return results;
  try {
    const candidates = results.slice(0, candidateLimit);
    fetchMissingChunkTexts(candidates); // sync — better-sqlite3 has no async API
    const rerankScores = await reranker.scoreAll(
      query,
      candidates.map(
        (c): RerankCandidate => ({ title: c.title, chunkText: c.chunkText, snippet: c.snippet }),
      ),
    );
    // Position-aware blending: mix normalized hybrid score with sigmoid(logit).
    // Pre-rerank hybrid position determines how much we trust retrieval vs reranker:
    //   ranks  0-9  → 75% hybrid + 25% reranker  (high retrieval confidence)
    //   ranks 10-19 → 60% hybrid + 40% reranker
    //   ranks 20+   → 40% hybrid + 60% reranker  (low retrieval confidence)
    // Hybrid scores are min-max normalized within the candidate batch so both
    // signals live in [0, 1] before blending.
    const withLogits = candidates.map((c, i) => ({
      c,
      logit: rerankScores[i] ?? 0,
      origRank: i,
    }));

    const hybridScores = withLogits.map(({ c }) => c.scores.hybrid ?? c.score);
    const minH = Math.min(...hybridScores);
    const maxH = Math.max(...hybridScores);
    const rangeH = maxH - minH || 1; // guard against single-candidate edge case

    const blended = withLogits.map(({ c, logit, origRank }) => {
      const normHybrid = ((c.scores.hybrid ?? c.score) - minH) / rangeH;
      const sigmaScore = 1 / (1 + Math.exp(-logit));
      const w = origRank < 10 ? 0.75 : origRank < 20 ? 0.6 : 0.4;
      return { c, score: w * normHybrid + (1 - w) * sigmaScore };
    });

    blended.sort((a, b) => b.score - a.score);
    return blended.map(({ c, score }) => ({ ...c, score }));
  } catch (err) {
    process.stderr.write(
      `Reranking failed: ${err instanceof Error ? err.message : String(err)}. Returning original order.\n`,
    );
    return results;
  }
}

async function searchByQuery(
  query: string,
  mode: string,
  limit: number,
  snippetLength: number,
  rerank = false,
): Promise<RawResult[]> {
  if (rerank && mode !== 'hybrid') {
    process.stderr.write('Reranking is only supported in hybrid mode. Ignoring --rerank.\n');
    rerank = false;
  }

  if (mode === 'fulltext') {
    return searchBm25(query, limit, snippetLength);
  }

  if (mode === 'title') {
    return searchFuzzyTitle(query, limit);
  }

  if (mode === 'semantic') {
    const f32 = await embedQuery(query);
    // If embedding permanently failed after retries, return empty rather than
    // polluting results with uniform zero-vector scores.
    if (!f32) return [];
    return searchVector(f32, limit);
  }

  // hybrid: RRF fusion of all three
  // embedQuery() retries on transient failures; on permanent failure it returns null
  // and vectorResults becomes [], so RRF degrades to BM25 + fuzzy (still useful).
  //
  // Use a minimum candidate pool for sub-queries so RRF has enough signal to rank
  // correctly even when limit=1. Without this, each sub-query returns only its own
  // #1 result and the BM25 winner (weight=2.0) always beats the true hybrid winner.
  // The caller (search()) already slices to `limit` after filtering.
  const candidateLimit = Math.max(limit, 20);
  const f32 = await embedQuery(query);
  const [bm25Results, fuzzyResults, vectorResults] = await Promise.all([
    Promise.resolve(searchBm25(query, candidateLimit, snippetLength)),
    Promise.resolve(searchFuzzyTitle(query, candidateLimit)),
    f32 ? searchVector(f32, candidateLimit) : Promise.resolve([]),
  ]);

  // Exact alias matches (fuzzy_title=1.0) are canonical identity signals — treated like BM25.
  // Partial fuzzy matches (trigram overlap < 1.0) remain at low weight to avoid false positives.
  const exactAliasResults = fuzzyResults.filter((r) => r.scores.fuzzy_title === 1.0);
  const partialFuzzyResults = fuzzyResults.filter((r) => r.scores.fuzzy_title !== 1.0);
  let results = rrfFusion(
    [vectorResults, bm25Results, exactAliasResults, partialFuzzyResults],
    60,
    [1.0, 2.0, 2.0, 0.5],
  );

  // Populate scores.hybrid for hybrid mode — always, regardless of rerank flag
  for (const r of results) {
    r.scores.hybrid = r.score;
  }

  if (rerank) {
    results = await applyRerank(results, query, candidateLimit);
  }

  return results;
}

async function searchSimilar(notePath: string, limit: number): Promise<RawResult[]> {
  // macOS stores filenames as NFD; normalize to match DB paths
  const normalizedPath = notePath.normalize('NFD');
  const note = getNoteByPath(normalizedPath);
  if (!note) return [];

  // Use already-stored chunk embeddings — avoids redundant re-embedding and truncation
  // (the local model caps at 512 tokens, so long notes lose their tail when re-embedded).
  // Each chunk was embedded at index time; we search with each and merge by max score.
  const chunkEmbeddings = getChunkEmbeddingsByPath(normalizedPath);

  if (chunkEmbeddings.length === 0) {
    // Fallback: note was never indexed with embeddings (e.g. embedding API was down)
    const f32 = await embedQuery(`${note.title}\n\n${note.content}`);
    if (!f32) return [];
    const excluded = new Set([note.path, ...getOutgoingLinks(normalizedPath)]);
    return (await searchVector(f32, limit + 1))
      .filter((r) => !excluded.has(r.path))
      .slice(0, limit);
  }

  // Exclude the source note itself and notes it already links to — they are already known.
  const excluded = new Set([note.path, ...getOutgoingLinks(normalizedPath)]);

  // Run vector search per chunk, deduplicate by path keeping the max score
  const allResults = (
    await Promise.all(chunkEmbeddings.map((f32) => searchVector(f32, limit + 1)))
  ).flat();

  const byPath = new Map<string, RawResult>();
  for (const r of allResults) {
    if (excluded.has(r.path)) continue;
    const existing = byPath.get(r.path);
    if (!existing || r.score > existing.score) byPath.set(r.path, r);
  }

  return [...byPath.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * Fetch one or more notes by vault-relative path.
 * Returns enriched note data (title, aliases, tags, content, links, backlinks).
 * On path miss: returns found:false with top-3 fuzzy title suggestions.
 * Results are returned in the same order as the input paths array.
 */
export function readNotes(
  paths: string[],
  options: { snippetLength?: number; related?: boolean } = {},
): ReadResult[] {
  const { snippetLength, related = true } = options;
  const results: ReadResult[] = [];

  for (const inputPath of paths) {
    const normalizedPath = inputPath.normalize('NFD');
    const note = getNoteByPath(normalizedPath);

    if (!note) {
      const basename = path.basename(inputPath, '.md');
      const suggestions = searchFuzzyTitle(basename, 3).map((r) => r.path);
      results.push({ path: inputPath, found: false, suggestions });
      continue;
    }

    let tags: string[];
    try {
      tags = JSON.parse(note.tags || '[]') as string[];
    } catch {
      tags = [];
    }

    const aliases = parseAliases(note.aliases);
    let content = note.content ?? '';
    if (snippetLength !== undefined && content.length > snippetLength) {
      content = content.slice(0, snippetLength);
    }

    let links: string[] = [];
    let backlinks: string[] = [];

    if (related) {
      const linkMap = getLinksForPaths([normalizedPath]);
      links = linkMap.links.get(normalizedPath) ?? [];
      backlinks = linkMap.backlinks.get(normalizedPath) ?? [];
    }

    results.push({
      path: note.path,
      found: true,
      title: note.title ?? '',
      aliases,
      tags,
      content,
      links,
      backlinks,
    });
  }

  return results;
}
