import { normalizeTag } from './db.js';

export interface FilterPredicate {
  /** SQL boolean expression over the alias `n` (the `notes` table), already
   *  parenthesised — the scope arm is an OR expression and unparenthesised
   *  concatenation silently rebinds the surrounding AND. */
  sql: string;
  params: Array<string | number>;
  /** True when no clause was produced. Callers MUST omit the clause entirely so an
   *  unfiltered query keeps a byte-identical SQL string and better-sqlite3 reuses
   *  the same prepared statement. */
  isEmpty: boolean;
}

interface FilterOptions {
  tag?: string | string[];
  scope?: string | string[];
  frontmatter?: string | string[];
}

/**
 * True when a tag/scope/frontmatter option carries an actual filter value.
 *
 * THE single answer to "is this filter present?" — every site that asks must call
 * this one. The predicate used to be open-coded at four sites with two different
 * answers for the empty string, which stayed correct only by accident of where the
 * trailing filters happened to run. An empty string and an empty array both mean
 * ABSENT: that matches what the resolver and the result pipeline already do, and it
 * avoids resolving a whole-vault candidate set for a filter that filters nothing.
 *
 * It lives here rather than in searcher.ts because both this builder and searcher.ts
 * need it, and searcher.ts imports this module — defining it there would make the
 * two files mutually importing.
 */
export function hasFilterValue(v: string | string[] | undefined): boolean {
  if (v === undefined) return false;
  return Array.isArray(v) ? v.length > 0 : v !== '';
}

const asArray = (v: string | string[] | undefined): string[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

function partition(values: string[]): { includes: string[]; excludes: string[] } {
  const includes: string[] = [];
  const excludes: string[] = [];
  for (const raw of values) {
    if (raw.startsWith('-')) excludes.push(raw.slice(1));
    else includes.push(raw);
  }
  return { includes, excludes };
}

/**
 * Correlated EXISTS, deliberately. The uncorrelated `n.id IN (SELECT …)` form was
 * measured 3.5x slower here (0.359 ms vs 0.103 ms): the `OR tag_norm LIKE ?`
 * disjunction defeats idx_note_tags_tag_norm, and only the correlated form can fall
 * back to the note_id index.
 *
 * Matching is `= value OR LIKE %value%` — SUBSTRING, so `meta` also matches
 * `metadata`. Pre-existing and deliberate (it mirrors filterNotePathsByTag).
 * Do not "fix" it here.
 */
function tagClause(value: string, params: Array<string | number>): string {
  const norm = normalizeTag(value);
  params.push(norm, `%${norm}%`);
  return `EXISTS (SELECT 1 FROM note_tags nt WHERE nt.note_id = n.id AND (nt.tag_norm = ? OR nt.tag_norm LIKE ?))`;
}

/** Field and value are lowercased only — NOT NFD-normalized. getMatchingNotesByFrontmatter
 *  behaves this way, and adding NFD breaks `status:🟦` and every Cyrillic value. */
function frontmatterClause(value: string, params: Array<string | number>): string | null {
  const colon = value.indexOf(':');
  if (colon === -1) return null;
  params.push(value.slice(0, colon).toLowerCase(), value.slice(colon + 1).toLowerCase());
  return `EXISTS (SELECT 1 FROM note_frontmatter_fields f WHERE f.note_id = n.id AND f.field = ? AND f.value_norm = ?)`;
}

/**
 * Prefix match as an index range rather than LIKE.
 *
 * '0' is the byte after '/' (0x30 vs 0x2F), so [p + '/', p + '0') covers exactly the
 * paths under the prefix. `path TEXT UNIQUE` gives a BINARY-collated index, so this
 * is a SEARCH, not a SCAN — 3x faster than LIKE + ESCAPE. It is also the only exact
 * option: a bare LIKE treats `_` as a wildcard, so scope "my_notes" would match
 * "myXnotes" too.
 *
 * The trailing slash must be stripped: matchesScopeFilter treats "notes/" and "notes"
 * alike, and appending unconditionally yields the empty range "notes//".."notes/0".
 */
function scopeClause(value: string, params: Array<string | number>): string {
  const normalized = value.normalize('NFD');
  // Hand-rolled trailing-'/' trim: the equivalent /\/+$/ regex is super-linear.
  let end = normalized.length;
  while (end > 0 && normalized[end - 1] === '/') end--;
  const prefix = normalized.slice(0, end);
  params.push(prefix, prefix + '/', prefix + '0');
  return `(n.path = ? OR (n.path >= ? AND n.path < ?))`;
}

export function buildFilterPredicate(options: FilterOptions): FilterPredicate {
  const empty: FilterPredicate = { sql: '', params: [], isEmpty: true };
  if (
    !hasFilterValue(options.tag) &&
    !hasFilterValue(options.scope) &&
    !hasFilterValue(options.frontmatter)
  ) {
    return empty;
  }

  const params: Array<string | number> = [];
  const clauses: string[] = [];

  const tags = partition(asArray(options.tag));
  for (const t of tags.includes) clauses.push(tagClause(t, params));
  for (const t of tags.excludes) clauses.push(`NOT ${tagClause(t, params)}`);

  const fm = partition(asArray(options.frontmatter));
  const fmIncludes = fm.includes
    .map((f) => frontmatterClause(f, params))
    .filter((c): c is string => c !== null);
  if (fm.includes.length > 0 && fmIncludes.length === 0) {
    // Includes were given but none parsed as field:value — match nothing rather than
    // silently degrading to "no frontmatter filter".
    clauses.push('0');
  } else {
    clauses.push(...fmIncludes);
  }
  for (const f of fm.excludes) {
    const c = frontmatterClause(f, params);
    if (c !== null) clauses.push(`NOT ${c}`);
  }

  const scope = partition(asArray(options.scope));
  if (scope.includes.length > 0) {
    clauses.push(`(${scope.includes.map((s) => scopeClause(s, params)).join(' OR ')})`);
  }
  for (const s of scope.excludes) clauses.push(`NOT ${scopeClause(s, params)}`);

  // Every supplied value was unparsable (e.g. frontmatter "-not-a-pair"), so nothing
  // constrains the query. Returning "()" here would be a SQL syntax error that the
  // arms' catch blocks would swallow into an empty result.
  if (clauses.length === 0) return empty;

  return { sql: `(${clauses.join(' AND ')})`, params, isEmpty: false };
}
