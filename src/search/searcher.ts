import path from 'node:path';
import {
  buildMatchText,
  buildMatchTextFromMarkedSnippet,
  stripSnippetMarkers,
} from '../content/chunker.js';
import {
  extractMarkdownReferenceOccurrences,
  resolveMarkdownNoteLinks,
} from '../content/markdown-references.js';
import { normalizeNotePath } from '../content/text-normalization.js';
import {
  buildFilterPredicate,
  hasFilterValue,
  type FilterPredicate,
} from '../contracts/filter-predicate.js';
import { embed } from '../inference/embedder.js';
import { reranker, type RerankCandidate } from '../inference/reranker.js';
import { config } from '../runtime/config.js';
import {
  filterNotePathsByFrontmatter,
  filterNotePathsByTag,
  getBacklinksForPaths,
  getChunkEmbeddingsByPath,
  getDbVersion,
  getLinksForPaths,
  getMarkdownLinksForPaths,
  getMatchingNotesByFrontmatter,
  getNoteByPath,
  getOutgoingLinksForPaths,
  getUrlsForPaths,
  hasVecTable,
  resolveNotePath,
} from '../storage/db.js';
import { getIndexVersion } from '../storage/index-state.js';
import {
  assertSearchStorageReady,
  createFuzzyTitleReader,
  createNoteContentReader,
  createVectorReader,
  findExactAliasRows,
  findSnippetHeading,
  listNoteIdentities,
  prepareBm25Rows,
  readChunksForPaths,
  readFirstChunkTexts,
  readNoteContent,
  readNoteIdentity,
  readSnippetContents,
} from '../storage/search-queries.js';
import { measureSearchStage, measureSearchStageSync } from './search-profile.js';

interface NoteReadResult {
  path: string;
  found: true;
  title: string;
  aliases: string[];
  tags: string[];
  content: string;
  links: string[];
  backlinks: string[];
  markdownLinks: string[];
  markdownBacklinks: string[];
  urls: string[];
}

interface NoteReadMiss {
  path: string;
  found: false;
  suggestions: string[];
}

export type ReadResult = NoteReadResult | NoteReadMiss;

export class AmbiguousNotePathError extends Error {
  constructor(
    public readonly input: string,
    public readonly candidates: string[],
  ) {
    super(`Ambiguous note path "${input}"`);
    this.name = 'AmbiguousNotePathError';
  }
}

export function isAmbiguousNotePathError(err: unknown): err is AmbiguousNotePathError {
  return err instanceof AmbiguousNotePathError;
}

interface MatchAnchor {
  kind: 'bm25' | 'semantic';
  headingPath: string | null;
  matchText: string; // first ~80 stripped chars of chunk body for DOM block lookup
  charStart: number | null; // null if chunk indexed before this migration
  charEnd: number | null;
}

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
  markdownLinks: string[];
  markdownBacklinks: string[];
  urls: string[];
  scores: {
    semantic: number | null;
    bm25: number | null;
    fuzzy_title: number | null;
    hybrid: number | null;
  };
  previewAnchors?: MatchAnchor[];
  primaryAnchorIndex?: number;
}

export interface SearchOptions {
  mode?: 'hybrid' | 'semantic' | 'fulltext' | 'title';
  scope?: string | string[];
  limit?: number;
  threshold?: number;
  tag?: string | string[];
  frontmatter?: string | string[];
  related?: boolean;
  depth?: number;
  direction?: 'outgoing' | 'backlinks' | 'both';
  linkType?: 'wiki' | 'markdown' | 'all';
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
  /** When true, populates previewAnchors on each result with chunk location data. */
  anchors?: boolean;
}

interface RawResult {
  path: string;
  title: string;
  tags: string;
  parsedTags?: string[];
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
  semanticAnchor?: MatchAnchor;
  bm25Anchor?: MatchAnchor;
}

export function matchesScopeFilter(notePath: string, scope: string | string[]): boolean {
  const scopes = (Array.isArray(scope) ? scope : [scope]).map(normalizeNotePath);
  const includes = scopes.filter((s) => !s.startsWith('-'));
  const excludes = scopes.filter((s) => s.startsWith('-')).map((s) => s.slice(1));
  // A scope prefix matches a path when the path is exactly the prefix or the
  // prefix is a parent directory (followed by '/'). This prevents 'notes' from
  // matching 'notes-old/foo.md'. Multiple excludes = AND logic (note must NOT
  // match ANY of the excludes).
  const scopeMatches = (path: string, prefix: string): boolean =>
    path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : prefix + '/');
  if (excludes.some((ex) => scopeMatches(notePath, ex))) return false;
  // Multiple includes = OR logic (note must match ANY of the includes)
  if (includes.length === 0) return true;
  return includes.some((inc) => scopeMatches(notePath, inc));
}

function applyThreshold(results: RawResult[], threshold: number): RawResult[] {
  return results.filter((r) => r.score >= threshold);
}

function applyTagFilter(results: RawResult[], tag: string | string[]): RawResult[] {
  const allowedPaths = filterNotePathsByTag(
    results.map((result) => result.path),
    tag,
  );
  return results.filter((result) => allowedPaths.has(result.path));
}

function applyFrontmatterFilter(results: RawResult[], frontmatter: string | string[]): RawResult[] {
  const allowedPaths = filterNotePathsByFrontmatter(
    results.map((result) => result.path),
    frontmatter,
  );
  return results.filter((result) => allowedPaths.has(result.path));
}

function toSearchResult(r: RawResult): SearchResult {
  const tags = getParsedTags(r);
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
    markdownLinks: [],
    markdownBacklinks: [],
    urls: [],
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

function getParsedTags(result: RawResult): string[] {
  if (result.parsedTags) return result.parsedTags;
  try {
    result.parsedTags = JSON.parse(result.tags || '[]') as string[];
  } catch {
    result.parsedTags = [];
  }
  return result.parsedTags;
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

// Sentinel markers bracketing the actual FTS match inside snippet() output. A snippet
// window spans several sentences, so the true match isn't necessarily on its first
// line — these let buildMatchTextFromMarkedSnippet find the right one. Stripped from
// every snippet before it's exposed on RawResult; control chars won't appear in notes.
const SNIPPET_MARK_START = '';
const SNIPPET_MARK_END = '';

export function searchBm25(
  query: string,
  limit: number,
  snippetLength = 300,
  buildAnchors = false,
  predicate?: FilterPredicate,
): RawResult[] {
  const readRows = prepareBm25Rows(
    limit,
    snippetLength,
    SNIPPET_MARK_START,
    SNIPPET_MARK_END,
    predicate,
  );

  try {
    // Use OR so that documents are ranked by how many query terms they match (BM25
    // naturally scores full-match documents higher).  AND was filtering out
    // relevant documents whenever a single query word (e.g. "between", "organize")
    // was absent from the document—even if that document was the best conceptual
    // match for every other term in the query.
    const rows = readRows(toFtsQuery(query, 'OR'));

    const results: RawResult[] = rows.map((row) => ({
      path: row.path,
      title: row.title ?? '',
      tags: row.tags ?? '[]',
      aliases: row.aliases,
      snippet: stripSnippetMarkers(row.snippet ?? '', SNIPPET_MARK_START, SNIPPET_MARK_END),
      score: Math.max(0, Math.abs(row.rank) / (1 + Math.abs(row.rank))),
      scores: {
        bm25: Math.max(0, Math.abs(row.rank) / (1 + Math.abs(row.rank))),
      },
    }));
    // Enrich BM25 snippets with heading breadcrumb and/or build anchor data.
    // Skip when neither is needed (snippetLength=0 and buildAnchors=false).
    if (snippetLength > 0 || buildAnchors) {
      const chunkDataMap = getChunkDataForBm25Results(results);
      for (let i = 0; i < results.length; i++) {
        const result = results[i]!;
        const data = chunkDataMap.get(result.path);
        if (data) {
          if (snippetLength > 0 && data.headingPath) {
            result.snippet = `${data.headingPath}\n${result.snippet}`;
          }
          if (buildAnchors) {
            // Use the still-marked raw snippet (positioned near the match) for matchText,
            // not the full chunk — the sentinel markers pin down which line is the real hit.
            const rawSnippet = (rows[i]!.snippet ?? '').replace(/\.\.\./g, '');
            result.bm25Anchor = {
              kind: 'bm25',
              headingPath: data.headingPath,
              matchText: buildMatchTextFromMarkedSnippet(
                rawSnippet,
                SNIPPET_MARK_START,
                SNIPPET_MARK_END,
              ),
              charStart: data.charStart,
              charEnd: data.charEnd,
            };
          }
        }
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
function searchByAliasExact(
  query: string,
  limit: number,
  predicate?: FilterPredicate,
): RawResult[] {
  const rows = findExactAliasRows(query, limit, predicate);

  return rows.map((row) => ({
    path: row.path,
    title: row.title ?? '',
    tags: row.tags ?? '[]',
    aliases: row.aliases,
    snippet: '',
    score: 1.0,
    scores: { fuzzy_title: 1.0 },
  }));
}

/**
 * `predicate` is optional because readNotes() calls this for path-miss suggestions,
 * where the caller's filters must NOT apply.
 */
export function searchFuzzyTitle(
  query: string,
  limit: number,
  predicate?: FilterPredicate,
): RawResult[] {
  // Exact alias match first — handles short aliases (< 3 chars) and Cyrillic that
  // the trigram FTS can't tokenize, ensuring they always surface in title/hybrid mode.
  // It MUST get the same predicate: alias hits enter RRF at weight 2.0, and once the
  // post-filter is gone there is nothing downstream left to drop unfiltered ones.
  const aliasExact = searchByAliasExact(query, limit, predicate);
  const aliasExactPaths = new Set(aliasExact.map((r) => r.path));

  const readRows = createFuzzyTitleReader(buildTrigramOrQuery(query), limit, predicate);

  try {
    const ftsRows = readRows();

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
  return measureSearchStage('embedQuery', async () => {
    try {
      const [emb] = await embed([text], 'query');
      if (emb) return emb;
      // null = embedding failed (already retried internally)
      return null;
    } catch {
      return null;
    }
  });
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
  assertSearchStorageReady();
  const clean = snippetText
    .replace(/^\.\.\./, '')
    .replace(/\.\.\.$/, '')
    .trim();
  if (clean.length < 15) return null;
  const key = clean.slice(0, 60);

  // Strategy 1: chunk-based lookup
  try {
    const row = findSnippetHeading(notePath, key);
    if (row?.heading_path) return row.heading_path;
  } catch {
    // heading_path column may not exist yet (pre-reindex) — fall through to strategy 2
  }

  // Strategy 2: scan note content up to the snippet position
  const note = readNoteContent(notePath);
  if (!note?.content) return null;

  const pos = note.content.indexOf(key);
  if (pos === -1) return null;

  const before = note.content.slice(0, pos);
  const headingSlots: (string | null)[] = [null, null, null, null, null, null];
  for (const line of before.split('\n')) {
    const heading = parseMarkdownHeadingLine(line);
    if (heading) {
      headingSlots[heading.level - 1] = `${heading.marker} ${heading.text}`;
      for (let i = heading.level; i < 6; i++) headingSlots[i] = null;
    }
  }
  const chain = headingSlots.filter((s): s is string => s !== null);
  return chain.length > 0 ? chain.join(' > ') : null;
}

type Bm25ChunkData = {
  headingPath: string | null;
  chunkText: string;
  charStart: number | null;
  charEnd: number | null;
};

function getChunkDataForBm25Results(results: RawResult[]): Map<string, Bm25ChunkData> {
  if (results.length === 0) return new Map();

  assertSearchStorageReady();
  const snippetKeys = getSnippetKeysForHeadingLookup(results);
  if (snippetKeys.size === 0) return new Map();

  const uniquePaths = Array.from(new Set(snippetKeys.keys()));

  try {
    const rows = readChunksForPaths(uniquePaths);

    const chunkData = matchChunkDataFromRows(rows, snippetKeys);
    fillMissingChunkData(chunkData, snippetKeys);
    return chunkData;
  } catch {
    const fallback = new Map<string, Bm25ChunkData>();
    for (const result of results) {
      const key = snippetKeys.get(result.path) ?? '';
      const headingPath = getHeadingPathForSnippet(result.path, result.snippet);
      if (headingPath) {
        fallback.set(result.path, { headingPath, chunkText: key, charStart: null, charEnd: null });
      }
    }
    return fallback;
  }
}

function getSnippetKeysForHeadingLookup(results: RawResult[]): Map<string, string> {
  const snippetKeys = new Map<string, string>();
  for (const result of results) {
    const clean = result.snippet
      .replace(/^\.\.\./, '')
      .replace(/\.\.\.$/, '')
      .trim();
    if (clean.length < 15) continue;
    snippetKeys.set(result.path, clean.slice(0, 60));
  }
  return snippetKeys;
}

function matchChunkDataFromRows(
  rows: Array<{
    path: string;
    heading_path: string | null;
    text: string;
    char_start: number | null;
    char_end: number | null;
  }>,
  snippetKeys: Map<string, string>,
): Map<string, Bm25ChunkData> {
  const result = new Map<string, Bm25ChunkData>();
  for (const row of rows) {
    const key = snippetKeys.get(row.path);
    if (!key || !row.text.includes(key)) continue;

    const existing = result.get(row.path);
    // Don't replace a heading-path match with a null-heading one (prefer heading context)
    if (existing?.headingPath) continue;

    result.set(row.path, {
      headingPath: row.heading_path ?? null,
      chunkText: row.text,
      charStart: row.char_start ?? null,
      charEnd: row.char_end ?? null,
    });
  }
  return result;
}

function fillMissingChunkData(
  chunkData: Map<string, Bm25ChunkData>,
  snippetKeys: Map<string, string>,
): void {
  const readContent = createNoteContentReader();
  for (const [notePath, key] of snippetKeys) {
    if (chunkData.has(notePath)) continue;
    const note = readContent(notePath);
    if (!note?.content) continue;
    // Set data even when there's no heading before the match (headingPath may be null)
    if (!note.content.includes(key)) continue;
    const headingPath = getHeadingPathFromContent(note.content, key);
    chunkData.set(notePath, { headingPath, chunkText: key, charStart: null, charEnd: null });
  }
}

function getHeadingPathFromContent(content: string, key: string): string | null {
  const pos = content.indexOf(key);
  if (pos === -1) return null;

  const before = content.slice(0, pos);
  const headingSlots: (string | null)[] = [null, null, null, null, null, null];
  for (const line of before.split('\n')) {
    const heading = parseMarkdownHeadingLine(line);
    if (!heading) continue;
    headingSlots[heading.level - 1] = `${heading.marker} ${heading.text}`;
    for (let i = heading.level; i < 6; i++) headingSlots[i] = null;
  }
  const chain = headingSlots.filter((heading): heading is string => heading !== null);
  return chain.length > 0 ? chain.join(' > ') : null;
}

function parseMarkdownHeadingLine(
  line: string,
): { level: number; marker: string; text: string } | null {
  const trimmed = line.trim();
  let level = 0;
  while (level < 6 && trimmed[level] === '#') level++;
  if (level === 0 || !isMarkdownWhitespace(trimmed[level] ?? '')) return null;

  let textStart = level + 1;
  while (textStart < trimmed.length && isMarkdownWhitespace(trimmed[textStart]!)) textStart++;
  const text = trimmed.slice(textStart);
  if (!text) return null;
  return { level, marker: '#'.repeat(level), text };
}

function isMarkdownWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\r' || char === '\n' || char === '\f';
}

/**
 * @param excludeLinkedFrom when set, omits that note and everything it links to —
 *   the "already known" set for a similarity lookup.
 */
function searchVector(
  queryEmbedding: Float32Array,
  limit: number,
  predicate?: FilterPredicate,
  excludeLinkedFrom?: string,
): RawResult[] {
  if (!hasVecTable()) return [];

  return measureSearchStageSync('vectorSearch', () => {
    const readRows = createVectorReader(queryEmbedding, limit, predicate, excludeLinkedFrom);

    try {
      const rows = readRows();

      return rows.map((row) => {
        // cosine similarity from L2 for unit vectors: cos = 1 - L2² / 2
        const similarity = Math.max(0, 1 - (row.distance * row.distance) / 2);
        return {
          path: row.path,
          title: row.title ?? '',
          tags: row.tags ?? '[]',
          aliases: row.aliases,
          snippet: formatChunkSnippet(row.heading_path, row.chunk_text, row.chunk_index > 0),
          chunkText: row.chunk_text,
          score: similarity,
          scores: { semantic: similarity },
          semanticAnchor: {
            kind: 'semantic' as const,
            headingPath: row.heading_path ?? null,
            matchText: buildMatchText(row.chunk_text),
            charStart: row.char_start ?? null,
            charEnd: row.char_end ?? null,
          },
        };
      });
    } catch (error) {
      // Never swallow silently: an empty vector result is indistinguishable from
      // "no semantic matches", which hid the k-ceiling bug above for a long time.
      process.stderr.write(
        `Vector search failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return [];
    }
  });
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
          if (result.semanticAnchor) existing.result.semanticAnchor = result.semanticAnchor;
        }
        if (result.scores.bm25 !== undefined) {
          existing.result.scores.bm25 = result.scores.bm25;
          if (!existing.result.scores.semantic) existing.result.snippet = result.snippet;
          if (result.bm25Anchor) existing.result.bm25Anchor = result.bm25Anchor;
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
function getSnippetFallbacks(notePaths: string[], maxChars: number): Map<string, string> {
  if (notePaths.length === 0 || maxChars <= 0) return new Map();

  assertSearchStorageReady();
  const uniquePaths = Array.from(new Set(notePaths));
  const rows = readSnippetContents(uniquePaths);

  return new Map(
    rows.map((row) => {
      const contentSnippet = row.content ? row.content.slice(0, maxChars).trim() : '';
      const titleSnippet = row.title ? row.title.slice(0, maxChars).trim() : '';
      return [row.path, contentSnippet || titleSnippet];
    }),
  );
}

/**
 * Extract the sentence/line context around a wikilink [[target]] inside note content.
 */
function getLinkContext(noteContent: string, linkedNotePath: string, windowSize = 300): string {
  const basename = path.basename(linkedNotePath, '.md');
  // Match [[basename]], [[basename|alias]], [[basename#heading]], [[folder/basename]], etc.
  const escaped = basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`\\[\\[(?:[^\\]|#]*\\/)?${escaped}(?:[|#][^\\]]*)?\\]\\]`, 'i');

  const match = regex.exec(noteContent);
  if (!match) return '';

  let start = Math.max(0, match.index - windowSize);
  let end = Math.min(noteContent.length, match.index + match[0].length + windowSize);

  // Snap to word boundaries so we don't cut mid-word
  if (start > 0) {
    while (start < match.index && !/\s/.test(noteContent[start]!)) start++;
  }
  if (end < noteContent.length) {
    while (end > match.index + match[0].length && !/\s/.test(noteContent[end - 1]!)) end--;
  }

  const prefix = start > 0 ? '...' : '';
  const suffix = end < noteContent.length ? '...' : '';
  // Preserve newlines so CLI can strip line-based markdown (headings, blockquotes)
  return prefix + noteContent.slice(start, end).trim() + suffix;
}

function getContextAroundMatch(
  noteContent: string,
  matchIndex: number,
  matchLength: number,
  windowSize: number,
): string {
  const contextBudget = Math.max(0, windowSize - matchLength);
  const beforeBudget = Math.floor(contextBudget / 2);
  const afterBudget = contextBudget - beforeBudget;
  let start = Math.max(0, matchIndex - beforeBudget);
  let end = Math.min(noteContent.length, matchIndex + matchLength + afterBudget);

  if (start > 0) {
    while (start < matchIndex && !/\s/.test(noteContent[start]!)) start++;
  }
  if (end < noteContent.length) {
    while (end > matchIndex + matchLength && !/\s/.test(noteContent[end - 1]!)) end--;
  }

  const prefix = start > 0 ? '...' : '';
  const suffix = end < noteContent.length ? '...' : '';
  return prefix + noteContent.slice(start, end).trim() + suffix;
}

function getMarkdownLinkContext(
  noteContent: string,
  sourcePath: string,
  linkedNotePath: string,
  windowSize = 300,
): string {
  const normalizedTarget = normalizeNotePath(linkedNotePath);
  const occurrences = extractMarkdownReferenceOccurrences(noteContent).localDestinations;
  for (const occurrence of occurrences) {
    const resolved = resolveMarkdownNoteLinks(
      sourcePath,
      [occurrence.destination],
      new Set([normalizedTarget]),
    );
    if (resolved.includes(normalizedTarget)) {
      return getContextAroundMatch(
        noteContent,
        occurrence.startOffset,
        occurrence.endOffset - occurrence.startOffset,
        windowSize,
      );
    }
  }

  return '';
}

function getCachedNoteContent(cache: Map<string, string>, notePath: string): string {
  const cached = cache.get(notePath);
  if (cached !== undefined) return cached;
  const note = readNoteContent(notePath);
  const content = note?.content ?? '';
  cache.set(notePath, content);
  return content;
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- primary search aggregation pipeline, intentionally dense
function searchRelated(
  notePath: string,
  maxDepth: number,
  direction: 'outgoing' | 'backlinks' | 'both' = 'both',
  snippetLength = 300,
  linkType: 'wiki' | 'markdown' | 'all' = 'wiki',
): SearchResult[] {
  assertSearchStorageReady();
  const sourcePath = normalizeNotePath(notePath);
  const results: SearchResult[] = [];
  const resultIndexes = new Map<string, number>();
  const contentCache = new Map<string, string>();

  const makeResult = (notePth: string, depth: number, snippet: string): SearchResult | null => {
    const note = readNoteIdentity(notePth);
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
      markdownLinks: [],
      markdownBacklinks: [],
      urls: [],
      scores: { semantic: null, bm25: null, fuzzy_title: null, hybrid: null },
    };
  };

  // Source note at depth 0
  const source = makeResult(sourcePath, 0, '');
  if (!source) return [];
  results.push(source);
  resultIndexes.set(sourcePath, 0);

  const addOrMergeResult = (
    notePth: string,
    depth: number,
    snippet: string,
    matchedBy: 'link' | 'backlink' | 'markdown_link' | 'markdown_backlink',
  ): boolean => {
    const existingIndex = resultIndexes.get(notePth);
    if (existingIndex !== undefined) {
      const existing = results[existingIndex]!;
      const existingAbs = Math.abs(existing.depth ?? 0);
      const nextAbs = Math.abs(depth);
      if (nextAbs < existingAbs) {
        const replacement = makeResult(notePth, depth, snippet);
        if (!replacement) return false;
        replacement.matchedBy = [matchedBy];
        results[existingIndex] = replacement;
        return false;
      }
      if (nextAbs === existingAbs && !existing.matchedBy.includes(matchedBy)) {
        existing.matchedBy.push(matchedBy);
      }
      return false;
    }

    const r = makeResult(notePth, depth, snippet);
    if (!r) return false;
    r.matchedBy = [matchedBy];
    resultIndexes.set(notePth, results.length);
    results.push(r);
    return true;
  };

  const getOutgoingEdges = (
    frontierPaths: string[],
  ): Map<string, Array<{ path: string; matchedBy: 'link' | 'markdown_link' }>> => {
    const edges = new Map<string, Array<{ path: string; matchedBy: 'link' | 'markdown_link' }>>();
    for (const frontierPath of frontierPaths) edges.set(frontierPath, []);
    if (linkType === 'wiki' || linkType === 'all') {
      const wikiLinks = getOutgoingLinksForPaths(frontierPaths);
      for (const frontierPath of frontierPaths) {
        for (const target of wikiLinks.get(frontierPath) ?? []) {
          edges.get(frontierPath)!.push({ path: target, matchedBy: 'link' });
        }
      }
    }
    if (linkType === 'markdown' || linkType === 'all') {
      const markdownLinks = getMarkdownLinksForPaths(frontierPaths).links;
      for (const frontierPath of frontierPaths) {
        for (const target of markdownLinks.get(frontierPath) ?? []) {
          edges.get(frontierPath)!.push({ path: target, matchedBy: 'markdown_link' });
        }
      }
    }
    return edges;
  };

  const getBacklinkEdges = (
    frontierPaths: string[],
  ): Map<string, Array<{ path: string; matchedBy: 'backlink' | 'markdown_backlink' }>> => {
    const edges = new Map<
      string,
      Array<{ path: string; matchedBy: 'backlink' | 'markdown_backlink' }>
    >();
    for (const frontierPath of frontierPaths) edges.set(frontierPath, []);
    if (linkType === 'wiki' || linkType === 'all') {
      const wikiBacklinks = getBacklinksForPaths(frontierPaths);
      for (const frontierPath of frontierPaths) {
        for (const source of wikiBacklinks.get(frontierPath) ?? []) {
          edges.get(frontierPath)!.push({ path: source, matchedBy: 'backlink' });
        }
      }
    }
    if (linkType === 'markdown' || linkType === 'all') {
      const markdownBacklinks = getMarkdownLinksForPaths(frontierPaths).backlinks;
      for (const frontierPath of frontierPaths) {
        for (const source of markdownBacklinks.get(frontierPath) ?? []) {
          edges.get(frontierPath)!.push({ path: source, matchedBy: 'markdown_backlink' });
        }
      }
    }
    return edges;
  };

  // Forward BFS — follow outgoing links (+depth)
  if (direction === 'outgoing' || direction === 'both') {
    const visitedFwd = new Set<string>([sourcePath]);
    let frontier = [sourcePath];
    for (let d = 1; d <= maxDepth; d++) {
      const next: string[] = [];
      const linksByParent = getOutgoingEdges(frontier);
      for (const parentPath of frontier) {
        for (const edge of linksByParent.get(parentPath) ?? []) {
          const parentContent = getCachedNoteContent(contentCache, parentPath);
          const snippet =
            edge.matchedBy === 'markdown_link'
              ? getMarkdownLinkContext(parentContent, parentPath, edge.path, snippetLength)
              : getLinkContext(parentContent, edge.path, snippetLength);
          addOrMergeResult(edge.path, d, snippet, edge.matchedBy);
          if (visitedFwd.has(edge.path)) continue;
          visitedFwd.add(edge.path);
          if (resultIndexes.has(edge.path)) next.push(edge.path);
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
      const backlinksByParent = getBacklinkEdges(frontier);
      for (const parentPath of frontier) {
        for (const edge of backlinksByParent.get(parentPath) ?? []) {
          const fromContent = getCachedNoteContent(contentCache, edge.path);
          const snippet =
            edge.matchedBy === 'markdown_backlink'
              ? getMarkdownLinkContext(fromContent, edge.path, parentPath, snippetLength)
              : getLinkContext(fromContent, parentPath, snippetLength);
          addOrMergeResult(edge.path, -d, snippet, edge.matchedBy);
          if (visitedBwd.has(edge.path)) continue;
          visitedBwd.add(edge.path);
          if (resultIndexes.has(edge.path)) next.push(edge.path);
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
  const markdown = getMarkdownLinksForPaths(paths);
  const urls = getUrlsForPaths(paths);
  for (const r of results) {
    r.links = links.get(r.path) ?? [];
    r.backlinks = backlinks.get(r.path) ?? [];
    r.markdownLinks = markdown.links.get(r.path) ?? [];
    r.markdownBacklinks = markdown.backlinks.get(r.path) ?? [];
    r.urls = urls.get(r.path) ?? [];
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

/** Ceiling used when the caller asks for "no limit" (limit === 0). Mirrors the
 *  filter-only branch's FETCH_ALL so both paths cap the vault the same way. */
const UNLIMITED_RESULTS = 10000;

function cacheKey(input: string, options: SearchOptions): string {
  const scopeStr = Array.isArray(options.scope) ? options.scope.join(',') : (options.scope ?? '');
  const tagStr = Array.isArray(options.tag) ? options.tag.join(',') : (options.tag ?? '');
  const fmStr = Array.isArray(options.frontmatter)
    ? options.frontmatter.join(',')
    : (options.frontmatter ?? '');
  // Include reranker model so that changing RERANKER_MODEL invalidates the cache
  const rerankStr = options.rerank ? config.rerankerModel : '';
  const queriesStr = options.queries && options.queries.length > 1 ? options.queries.join('|') : '';
  const anchorsStr = options.anchors ? 'a' : '';
  // Two-component version:
  //   getDbVersion() — shared via SQLite settings; any process that modifies the DB
  //                    bumps it, invalidating caches in all other processes.
  //   localVersion   — in-process counter; bumpIndexVersion() for test-suite isolation.
  return `v${getDbVersion()}_${getIndexVersion()}\0${input}\0${options.mode ?? ''}\0${scopeStr}\0${options.limit ?? ''}\0${options.threshold ?? ''}\0${tagStr}\0${fmStr}\0${options.snippetLength ?? ''}\0${options.notePath ?? ''}\0${rerankStr}\0${queriesStr}\0${anchorsStr}`;
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- primary search entry-point; complexity is inherent in the multi-mode, multi-filter pipeline
export async function search(input: string, options: SearchOptions = {}): Promise<SearchResult[]> {
  const mode = options.mode ?? 'hybrid';
  const limit = options.limit ?? 10;
  const threshold = options.threshold ?? 0.0;
  const noLimit = limit === 0;
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
  let resolvedPath = options.notePath ?? input;
  if (isPathLookup) {
    const resolution = resolveNotePath(resolvedPath);
    if (resolution?.type === 'ambiguous') {
      throw new AmbiguousNotePathError(resolvedPath, resolution.candidates);
    }
    if (resolution?.type === 'resolved') {
      resolvedPath = resolution.path;
    }
  }

  // Related mode: graph traversal, skip the normal search pipeline
  if (isPathLookup && options.related) {
    const maxDepth = options.depth ?? 1;
    const direction = options.direction ?? 'both';
    const linkType = options.linkType ?? 'wiki';
    const scopeStr = Array.isArray(options.scope) ? options.scope.join(',') : (options.scope ?? '');
    const tagStr = Array.isArray(options.tag) ? options.tag.join(',') : (options.tag ?? '');
    const fmStr = Array.isArray(options.frontmatter)
      ? options.frontmatter.join(',')
      : (options.frontmatter ?? '');
    const key = `related\0v${getDbVersion()}_${getIndexVersion()}\0${resolvedPath}\0${maxDepth}\0${direction}\0${linkType}\0${snippetLength}\0${scopeStr}\0${tagStr}\0${fmStr}`;
    const cached = searchCache.get(key);
    if (cached) return cached;
    let related = searchRelated(resolvedPath, maxDepth, direction, snippetLength, linkType);
    // Apply scope, tag, and frontmatter filters (related bypasses the normal pipeline)
    if (hasFilterValue(options.scope)) {
      related = related.filter((r) => matchesScopeFilter(r.path, options.scope!));
    }
    if (hasFilterValue(options.tag)) {
      const allowedPaths = filterNotePathsByTag(
        related.map((result) => result.path),
        options.tag!,
      );
      related = related.filter((result) => allowedPaths.has(result.path));
    }
    if (hasFilterValue(options.frontmatter)) {
      const allowedPaths = filterNotePathsByFrontmatter(
        related.map((result) => result.path),
        options.frontmatter!,
      );
      related = related.filter((result) => allowedPaths.has(result.path));
    }
    const fallbackSnippets = getSnippetFallbacks(
      related.filter((r) => !r.snippet || r.snippet.length < snippetLength).map((r) => r.path),
      snippetLength,
    );
    // Expand short snippets up to snippetLength, then cap
    for (const r of related) {
      if (!r.snippet || r.snippet.length < snippetLength) {
        const fallback = fallbackSnippets.get(r.path) ?? '';
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

  // Filter-only mode: no text query, but filters present (frontmatter, tag, scope)
  // Return all matching notes sorted by title
  const hasFrontmatterFilter = hasFilterValue(options.frontmatter);
  const hasTagFilter = hasFilterValue(options.tag);
  const hasScopeFilter = hasFilterValue(options.scope);

  if (!input && !isPathLookup && (hasFrontmatterFilter || hasTagFilter || hasScopeFilter)) {
    const fmKey = cacheKey('', options);
    const cachedFm = searchCache.get(fmKey);
    if (cachedFm) return cachedFm;

    // Always fetch a large batch so filters can see the full vault, then slice to limit.
    const FETCH_ALL = 10000;
    let fmResults: RawResult[];

    if (hasFrontmatterFilter) {
      const matches = getMatchingNotesByFrontmatter(options.frontmatter!, FETCH_ALL);
      fmResults = matches.map((m) => ({
        path: m.path,
        title: m.title ?? '',
        tags: m.tags ?? '[]',
        aliases: m.aliases,
        snippet: '',
        score: 1.0,
        scores: { hybrid: 1.0 },
      }));
    } else {
      assertSearchStorageReady();
      const rows = listNoteIdentities(FETCH_ALL);
      fmResults = rows.map((m) => ({
        path: m.path,
        title: m.title ?? '',
        tags: m.tags ?? '[]',
        aliases: m.aliases,
        snippet: '',
        score: 1.0,
        scores: { hybrid: 1.0 },
      }));
    }

    // Apply scope filter
    if (hasScopeFilter) {
      fmResults = fmResults.filter((r) => matchesScopeFilter(r.path, options.scope!));
    }

    // Apply tag filter
    if (hasTagFilter) {
      fmResults = applyTagFilter(fmResults, options.tag!);
    }

    // Apply frontmatter filter
    if (hasFrontmatterFilter) {
      fmResults = applyFrontmatterFilter(fmResults, options.frontmatter!);
    }

    // Apply limit (0 = no limit)
    if (limit > 0) {
      fmResults = fmResults.slice(0, limit);
    }

    const finalResults = fmResults.map((r, i) => {
      const sr = toSearchResult(r);
      sr.rank = i + 1;
      return sr;
    });

    searchCache.set(fmKey, finalResults);

    return finalResults;
  }

  // For path lookups, include mtime in cache key so stale entries auto-invalidate
  let key = cacheKey(resolvedPath, options);
  if (isPathLookup) {
    const note = getNoteByPath(normalizeNotePath(resolvedPath));
    if (note) key += `\0${note.mtime}`;
  }
  const cached = searchCache.get(key);
  if (cached) return cached;

  let results: RawResult[];

  // limit === 0 means "no limit" — the semantics the filter-only branch above
  // already implements and the CLI/MCP flags document. Retrieval still needs a
  // finite pool, so it borrows the same ceiling the filter-only branch uses; the
  // final slice below is what is actually skipped.
  const retrievalLimit = noLimit ? UNLIMITED_RESULTS : limit;

  // Built ONCE and threaded into every retrieval arm, so the filter narrows the pool
  // the query itself scans instead of trimming an already-truncated result list. A
  // narrow filter used to return nothing at a small limit for exactly that reason.
  const predicate = buildFilterPredicate(options);

  if (isPathLookup) {
    results = await searchSimilar(resolvedPath, retrievalLimit, predicate);
  } else if (options.queries && options.queries.length > 1) {
    // Multi-query fan-out: run each query in parallel, merge via RRF, then rerank once.
    // Each sub-search uses a larger candidate pool so RRF has enough signal to rank correctly.
    const candidateLimit = Math.max(retrievalLimit * 2, 20);
    const perQueryResults = await Promise.all(
      options.queries.map((q) =>
        searchByQuery(
          q,
          mode,
          candidateLimit,
          snippetLength,
          false,
          options.anchors ?? false,
          predicate,
        ),
      ),
    );
    results = measureSearchStageSync('rrfFusion', () => rrfFusion(perQueryResults, 60));
    // Populate scores.hybrid on merged results (mirrors single-query hybrid path)
    for (const r of results) {
      r.scores.hybrid = r.score;
    }
    // Rerank after full merge — only in hybrid mode
    if (options.rerank) {
      if (mode !== 'hybrid') {
        process.stderr.write('Reranking is only supported in hybrid mode. Ignoring --rerank.\n');
      } else {
        results = await measureSearchStage('rerank', () =>
          applyRerank(results, options.queries![0]!, candidateLimit),
        );
      }
    }
  } else {
    results = await searchByQuery(
      input,
      mode,
      retrievalLimit,
      snippetLength,
      options.rerank ?? false,
      options.anchors ?? false,
      predicate,
    );
  }

  const { filteredResults, final } = measureSearchStageSync('filterAndFormat', () => {
    // Scope, tag and frontmatter are pushed into every retrieval arm as a SQL
    // predicate, so there is nothing left for them to trim here. applyThreshold
    // STAYS: it is a score cutoff, cannot be expressed as a predicate over `notes`,
    // and deleting it silently turns --threshold into a no-op. It must keep running
    // BEFORE the final slice, or a below-threshold result would consume a slot.
    let filteredResults = applyThreshold(results, threshold);
    if (!noLimit) filteredResults = filteredResults.slice(0, limit);

    const paths = filteredResults.map((r) => r.path);
    const { links, backlinks } = getLinksForPaths(paths);
    const markdown = getMarkdownLinksForPaths(paths);
    const urls = getUrlsForPaths(paths);
    const fallbackSnippets = getSnippetFallbacks(
      paths.filter((path, index) => {
        const raw = filteredResults[index];
        return raw ? !raw.snippet || raw.snippet.length < snippetLength : false;
      }),
      snippetLength,
    );

    const final = filteredResults.map((r, i) => {
      const sr = toSearchResult(r);
      if (!sr.snippet || sr.snippet.length < snippetLength) {
        const fallback = fallbackSnippets.get(sr.path) ?? '';
        if (fallback.length > sr.snippet.length) sr.snippet = fallback;
      }
      if (sr.snippet.length > snippetLength) sr.snippet = sr.snippet.slice(0, snippetLength);
      return {
        ...sr,
        rank: i + 1,
        links: links.get(sr.path) ?? [],
        backlinks: backlinks.get(sr.path) ?? [],
        markdownLinks: markdown.links.get(sr.path) ?? [],
        markdownBacklinks: markdown.backlinks.get(sr.path) ?? [],
        urls: urls.get(sr.path) ?? [],
      };
    });

    return { filteredResults, final };
  });

  // Populate previewAnchors when requested (not for related mode — handled above)
  if (options.anchors) {
    for (let i = 0; i < final.length; i++) {
      const raw = filteredResults[i];
      if (!raw) continue;
      const anchors: MatchAnchor[] = [];
      if (raw.semanticAnchor) anchors.push(raw.semanticAnchor);
      if (raw.bm25Anchor) {
        // Deduplicate: skip BM25 anchor if it points to the same block as semantic
        if (!raw.semanticAnchor || raw.bm25Anchor.matchText !== raw.semanticAnchor.matchText) {
          anchors.push(raw.bm25Anchor);
        }
      }
      if (anchors.length > 0) {
        final[i]!.previewAnchors = anchors;
        final[i]!.primaryAnchorIndex = 0; // semantic (index 0) is always primary when present
      }
    }
  }

  searchCache.set(key, final);
  return final;
}

/**
 * For candidates that don't yet have chunkText (BM25/fuzzy results),
 * fetch the first chunk text from the DB. Mutates candidates in place.
 * better-sqlite3 is synchronous — no async needed.
 */
function fetchMissingChunkTexts(candidates: RawResult[]): void {
  const missingPaths = Array.from(
    new Set(
      candidates.filter((candidate) => !candidate.chunkText).map((candidate) => candidate.path),
    ),
  );
  if (missingPaths.length === 0) return;

  assertSearchStorageReady();
  const rows = readFirstChunkTexts(missingPaths);

  const chunkTexts = new Map(rows.map((row) => [row.path, row.text]));
  for (const candidate of candidates) {
    if (candidate.chunkText) continue;
    const chunkText = chunkTexts.get(candidate.path);
    if (chunkText) candidate.chunkText = chunkText;
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
      candidates.map((c): RerankCandidate => ({
        title: c.title,
        chunkText: c.chunkText,
        snippet: c.snippet,
      })),
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
  buildAnchors = false,
  predicate?: FilterPredicate,
): Promise<RawResult[]> {
  if (rerank && mode !== 'hybrid') {
    process.stderr.write('Reranking is only supported in hybrid mode. Ignoring --rerank.\n');
    rerank = false;
  }

  if (mode === 'fulltext') {
    return measureSearchStageSync('bm25', () =>
      searchBm25(query, limit, snippetLength, buildAnchors, predicate),
    );
  }

  if (mode === 'title') {
    // Fetch a larger candidate pool from FTS (BM25 order ≠ adjustedScore order),
    // then re-sort by adjustedScore and slice. Without this, notes ranked low by
    // BM25 but with high trigram overlap (e.g. exact title match) would be silently
    // dropped before scoring. Only done for title mode — hybrid uses rrfFusion which
    // depends on the original BM25 ordering from searchFuzzyTitle.
    const candidates = measureSearchStageSync('fuzzyTitle', () =>
      searchFuzzyTitle(query, Math.max(limit * 5, 50), predicate),
    );
    return candidates.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  if (mode === 'semantic') {
    const f32 = await embedQuery(query);
    // If embedding permanently failed after retries, return empty rather than
    // polluting results with uniform zero-vector scores.
    if (!f32) return [];
    return searchVector(f32, limit, predicate);
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
    Promise.resolve(
      measureSearchStageSync('bm25', () =>
        searchBm25(query, candidateLimit, snippetLength, buildAnchors, predicate),
      ),
    ),
    Promise.resolve(
      measureSearchStageSync('fuzzyTitle', () =>
        searchFuzzyTitle(query, candidateLimit, predicate),
      ),
    ),
    f32 ? searchVector(f32, candidateLimit, predicate) : Promise.resolve([]),
  ]);

  // Exact alias matches (fuzzy_title=1.0) are canonical identity signals — treated like BM25.
  // Partial fuzzy matches (trigram overlap < 1.0) remain at low weight to avoid false positives.
  const exactAliasResults = fuzzyResults.filter((r) => r.scores.fuzzy_title === 1.0);
  const partialFuzzyResults = fuzzyResults.filter((r) => r.scores.fuzzy_title !== 1.0);
  let results = measureSearchStageSync('rrfFusion', () =>
    rrfFusion(
      [vectorResults, bm25Results, exactAliasResults, partialFuzzyResults],
      60,
      [1.5, 1.5, 2.0, 0.25],
    ),
  );

  // Populate scores.hybrid for hybrid mode — always, regardless of rerank flag
  for (const r of results) {
    r.scores.hybrid = r.score;
  }

  if (rerank) {
    results = await measureSearchStage('rerank', () => applyRerank(results, query, candidateLimit));
  }

  return results;
}

/**
 * Source vectors for a similarity lookup.
 *
 * Prefers the chunk embeddings stored at index time — re-embedding would truncate
 * long notes (the local model caps at 512 tokens). Falls back to re-embedding the
 * whole note only when it was indexed without embeddings, e.g. the API was down.
 *
 * The "already known" set (the note itself plus everything it links to) is NOT
 * resolved here: it is pushed into the KNN as a SQL restriction, so it narrows the
 * pool the query scans instead of eating into an already-truncated top-N.
 */
async function getSimilaritySource(normalizedPath: string): Promise<Float32Array[] | null> {
  const note = getNoteByPath(normalizedPath);
  if (!note) return null;

  const stored = getChunkEmbeddingsByPath(normalizedPath);
  if (stored.length > 0) return stored;

  const f32 = await embedQuery(`${note.title}\n\n${note.content}`);
  if (!f32) return null;
  return [f32];
}

/**
 * KNN similarity to a note, with the tag/scope/frontmatter filter and the
 * self+outgoing-link exclusion both applied INSIDE the KNN.
 *
 * There is no `limit + 1` over-fetch: it existed only to absorb self-exclusion after
 * the fact, and the exclusion is now part of the query.
 */
async function searchSimilar(
  notePath: string,
  limit: number,
  predicate?: FilterPredicate,
): Promise<RawResult[]> {
  // macOS stores filenames as NFD; normalize to match DB paths
  const normalizedPath = normalizeNotePath(notePath);
  const embeddings = await getSimilaritySource(normalizedPath);
  if (!embeddings) return [];

  // Run vector search per source chunk, deduplicate by path keeping the max score
  const allResults = embeddings.flatMap((f32) =>
    searchVector(f32, limit, predicate, normalizedPath),
  );

  const byPath = new Map<string, RawResult>();
  for (const r of allResults) {
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
    const normalizedPath = normalizeNotePath(inputPath);
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
    let markdownLinks: string[] = [];
    let markdownBacklinks: string[] = [];

    if (related) {
      const linkMap = getLinksForPaths([normalizedPath]);
      links = linkMap.links.get(normalizedPath) ?? [];
      backlinks = linkMap.backlinks.get(normalizedPath) ?? [];
      const markdownMap = getMarkdownLinksForPaths([normalizedPath]);
      markdownLinks = markdownMap.links.get(normalizedPath) ?? [];
      markdownBacklinks = markdownMap.backlinks.get(normalizedPath) ?? [];
    }
    const urls = getUrlsForPaths([normalizedPath]).get(normalizedPath) ?? [];

    results.push({
      path: note.path,
      found: true,
      title: note.title ?? '',
      aliases,
      tags,
      content,
      links,
      backlinks,
      markdownLinks,
      markdownBacklinks,
      urls,
    });
  }

  return results;
}
