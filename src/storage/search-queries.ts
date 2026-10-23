import { getDb } from '../db.js';
import type { FilterPredicate } from '../filter-predicate.js';

type FtsRow = {
  path: string;
  title: string;
  tags: string;
  aliases: string | null;
  snippet: string;
  rank: number;
};

/**
 * The `AND <predicate>` fragment and the params to splice, or empty strings/arrays when
 * no filter is active.
 *
 * An inactive filter MUST contribute a byte-identical SQL string. Not for statement
 * reuse — better-sqlite3 has no SQL-text statement cache, every db.prepare() compiles
 * afresh — but because identical text is what keeps the unfiltered path's query plan and
 * its output stable, which is the property the frozen output capture pins. An
 * unconditional `AND 1` would hand SQLite a different statement to plan on every
 * unfiltered query in the codebase for no gain.
 */
function filterFragment(predicate: FilterPredicate | undefined): {
  clause: string;
  params: Array<string | number>;
} {
  if (predicate === undefined || predicate.isEmpty) return { clause: '', params: [] };
  return { clause: ` AND ${predicate.sql}`, params: predicate.params };
}

export function prepareBm25Rows(
  limit: number,
  snippetLength: number,
  markStart: string,
  markEnd: string,
  predicate?: FilterPredicate,
): (ftsQuery: string) => FtsRow[] {
  const db = getDb();
  const numTokens = Math.max(10, Math.ceil(snippetLength / 4));
  const filter = filterFragment(predicate);
  // Widened from the former fixed 5-tuple: the filter params are spliced in before
  // `limit`, so the bind list is variable-length.
  const stmt = db.prepare<Array<string | number>, FtsRow>(
    `
      SELECT n.path, n.title, n.tags, n.aliases,
             snippet(notes_fts_bm25, 2, ?, ?, '...', ?) AS snippet,
             bm25(notes_fts_bm25, 10.0, 5.0, 1.0) AS rank
      FROM notes_fts_bm25
      JOIN notes n ON n.id = notes_fts_bm25.rowid
      WHERE notes_fts_bm25 MATCH ?${filter.clause}
      ORDER BY rank
      LIMIT ?
    `,
  );

  return (ftsQuery) => {
    return stmt.all(markStart, markEnd, numTokens, ftsQuery, ...filter.params, limit);
  };
}

export function findExactAliasRows(query: string, limit: number, predicate?: FilterPredicate) {
  const db = getDb();
  const queryNfd = query.normalize('NFD').toLowerCase();
  const filter = filterFragment(predicate);

  return db
    .prepare(
      `
      SELECT DISTINCT n.path, n.title, n.tags, n.aliases
      FROM note_aliases a
      JOIN notes n ON n.id = a.note_id
      WHERE a.alias_norm = ?${filter.clause}
      LIMIT ?
    `,
    )
    .all(queryNfd, ...filter.params, limit) as Array<{
    path: string;
    title: string;
    tags: string;
    aliases: string | null;
  }>;
}

export function createFuzzyTitleReader(
  ftsQuery: string,
  limit: number,
  predicate?: FilterPredicate,
) {
  const db = getDb();
  const filter = filterFragment(predicate);
  return () => {
    return db
      .prepare(
        `
      SELECT n.path, n.title, n.tags, n.aliases,
             bm25(notes_fts_fuzzy) AS rank
      FROM notes_fts_fuzzy
      JOIN notes n ON n.id = notes_fts_fuzzy.rowid
      WHERE notes_fts_fuzzy MATCH ?${filter.clause}
      ORDER BY rank
      LIMIT ?
    `,
      )
      .all(ftsQuery, ...filter.params, limit) as Array<{
      path: string;
      title: string;
      tags: string;
      aliases: string | null;
      rank: number;
    }>;
  };
}

export function findSnippetHeading(notePath: string, key: string) {
  const db = getDb();
  return db
    .prepare(
      `SELECT c.heading_path FROM chunks c
         JOIN notes n ON n.id = c.note_id
         WHERE n.path = ? AND instr(c.text, ?) > 0
           AND c.heading_path IS NOT NULL
         ORDER BY c.chunk_index LIMIT 1`,
    )
    .get(notePath, key) as { heading_path: string } | undefined;
}

export function readNoteContent(notePath: string): { content: string } | undefined {
  return getDb().prepare('SELECT content FROM notes WHERE path = ?').get(notePath) as
    { content: string } | undefined;
}

export function readChunksForPaths(uniquePaths: string[]) {
  const db = getDb();
  const placeholders = uniquePaths.map(() => '?').join(', ');

  return db
    .prepare(
      `SELECT n.path, c.heading_path, c.text, c.chunk_index, c.char_start, c.char_end
         FROM notes n
         JOIN chunks c ON c.note_id = n.id
         WHERE n.path IN (${placeholders})
         ORDER BY n.path, c.chunk_index`,
    )
    .all(...uniquePaths) as Array<{
    path: string;
    heading_path: string | null;
    text: string;
    chunk_index: number;
    char_start: number | null;
    char_end: number | null;
  }>;
}

export function createNoteContentReader(): (notePath: string) => { content: string } | undefined {
  const stmt = getDb().prepare('SELECT content FROM notes WHERE path = ?');
  return (notePath) => stmt.get(notePath) as { content: string } | undefined;
}

/**
 * Hard ceiling sqlite-vec enforces on a KNN `k`. Exceeding it throws
 * "k value in knn query too large", which the catch below used to swallow into an
 * empty result — so any search with limit > 819 (k = limit * 5) silently returned
 * nothing, on every vault regardless of size. Clamp instead: k = 4096 already
 * over-fetches far past any sane result count, and the outer LIMIT does the trimming.
 */
const VEC_MAX_K = 4096;

export function createVectorReader(
  queryEmbedding: Float32Array,
  limit: number,
  predicate?: FilterPredicate,
  excludeLinkedFrom?: string,
) {
  // ── The vector arm's restriction form is the OPPOSITE of the FTS arms', and the
  // wrong one fails SILENTLY. sqlite-vec pre-filters a KNN ONLY when the restriction
  // is on its primary key as `vc.chunk_id IN (subquery)`. The correlated
  // `EXISTS (… WHERE nt.note_id = n.id …)` form — exactly what searchBm25 and
  // searchFuzzyTitle correctly use — compiles to a POST-filter here: k is taken first
  // and the restriction then throws the survivors away, so a narrow filter returns 0
  // rows instead of `limit`. Measured. Do NOT "harmonize" these two forms.
  // sqlite-vec applies a KNN restriction BEFORE taking k only when it is expressed
  // positively on the primary key, as `vc.chunk_id IN (subquery)`. `NOT IN` is NOT
  // recognized by that optimization: k is taken first and the exclusion then discards
  // the survivors, so a source note whose links fill the top-k returns nothing.
  // Measured. Everything therefore collapses into ONE positive `IN`, with the
  // exclusion carried inside it as a `NOT IN` over note ids — cheap there, because by
  // that point we are already inside a plain SQL subquery rather than the KNN itself.
  //
  // Do not "harmonize" this with the correlated EXISTS the FTS arms use: that form
  // compiles to a post-filter here and silently returns zero rows.
  const conditions: string[] = [];
  const extraParams: Array<string | number> = [];

  if (predicate !== undefined && !predicate.isEmpty) {
    // The predicate's clauses reference the alias `n`; inside this subquery the notes
    // table is aliased `n2` so it cannot shadow the outer join above.
    conditions.push(predicate.sql.replace(/\bn\./g, 'n2.'));
    extraParams.push(...predicate.params);
  }

  if (excludeLinkedFrom !== undefined) {
    // Driven from `links` rather than a correlated EXISTS: the correlated form forces
    // a full chunk scan and doubled the arm's cost (7.33 ms vs 4.94 ms on a 157-link
    // hub note). A bound parameter list is impossible — hub notes can have thousands
    // of links and such a list cannot be batched inside a single k-limited KNN.
    conditions.push(
      `c2.note_id NOT IN (
             SELECT n4.id FROM notes n4 WHERE n4.path = ?
             UNION
             SELECT n5.id FROM notes n5 JOIN links l ON l.to_path = n5.path WHERE l.from_path = ?)`,
    );
    extraParams.push(excludeLinkedFrom, excludeLinkedFrom);
  }

  const restrictions =
    conditions.length === 0
      ? []
      : [
          `vc.chunk_id IN (SELECT c2.id FROM chunks c2 JOIN notes n2 ON n2.id = c2.note_id WHERE ${conditions.join(' AND ')})`,
        ];

  const restrictionSql = restrictions.map((r) => `\n          AND ${r}`).join('');

  const db = getDb();
  return () => {
    return (
      db
        .prepare(
          `
      WITH ranked AS (
        SELECT vc.chunk_id, vc.distance,
               c.note_id, c.chunk_index, c.text AS chunk_text, c.heading_path,
               c.char_start, c.char_end,
               n.path, n.title, n.tags, n.aliases,
               ROW_NUMBER() OVER (PARTITION BY c.note_id ORDER BY vc.distance, c.chunk_index) AS row_num
        FROM vec_chunks AS vc
        JOIN chunks c ON c.id = vc.chunk_id
        JOIN notes n ON n.id = c.note_id
        WHERE vc.embedding MATCH ?
          AND k = ?${restrictionSql}
      )
      SELECT chunk_id, distance, note_id, chunk_index, chunk_text, heading_path,
             char_start, char_end, path, title, tags, aliases
      FROM ranked
      WHERE row_num = 1
      ORDER BY distance, chunk_index
      LIMIT ?
    `,
        )
        // `k` is validated by sqlite-vec BEFORE the pre-filter runs, so the VEC_MAX_K
        // clamp stays regardless of how narrow the restriction is.
        .all(queryEmbedding, Math.min(limit * 5, VEC_MAX_K), ...extraParams, limit) as Array<{
        chunk_id: number;
        distance: number;
        note_id: number;
        chunk_index: number;
        chunk_text: string;
        heading_path: string | null;
        char_start: number | null;
        char_end: number | null;
        path: string;
        title: string;
        tags: string;
        aliases: string | null;
      }>
    );
  };
}

export function readSnippetContents(uniquePaths: string[]) {
  const db = getDb();
  const placeholders = uniquePaths.map(() => '?').join(', ');
  return db
    .prepare(`SELECT path, title, content FROM notes WHERE path IN (${placeholders})`)
    .all(...uniquePaths) as Array<{ path: string; title: string | null; content: string | null }>;
}

export function readFirstChunkTexts(missingPaths: string[]) {
  const db = getDb();
  const placeholders = missingPaths.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT path, text
       FROM (
         SELECT n.path, c.text,
                ROW_NUMBER() OVER (PARTITION BY n.path ORDER BY c.chunk_index) AS row_num
         FROM chunks c
         JOIN notes n ON n.id = c.note_id
         WHERE n.path IN (${placeholders})
       )
       WHERE row_num = 1`,
    )
    .all(...missingPaths) as Array<{ path: string; text: string }>;
}

export function readNoteIdentity(notePth: string) {
  const db = getDb();
  return db.prepare('SELECT path, title, tags, aliases FROM notes WHERE path = ?').get(notePth) as
    { path: string; title: string; tags: string; aliases: string | null } | undefined;
}

export function listNoteIdentities(FETCH_ALL: number) {
  const db = getDb();
  return db
    .prepare('SELECT path, title, tags, aliases FROM notes ORDER BY title ASC LIMIT ?')
    .all(FETCH_ALL) as Array<{
    path: string;
    title: string;
    tags: string;
    aliases: string | null;
  }>;
}

/** Preserve acquisition failure before callers enter their query fallback blocks. */
export function assertSearchStorageReady(): void {
  getDb();
}
