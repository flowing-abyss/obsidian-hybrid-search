import Database from 'better-sqlite3';
import { statSync, unlinkSync } from 'node:fs';
import * as sqliteVec from 'sqlite-vec';
import { config } from './config.js';
import { isIgnored } from './ignore.js';

type DB = InstanceType<typeof Database>;

let _db: DB | null = null;

function normalizeAlias(alias: string): string {
  return alias.normalize('NFD').toLowerCase();
}

function normalizeTag(tag: string): string {
  return tag.normalize('NFD').toLowerCase();
}

function parseJsonStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    return (JSON.parse(raw) as unknown[]).filter(
      (value): value is string => typeof value === 'string',
    );
  } catch {
    return [];
  }
}

const parseAliasesJson = parseJsonStringArray;
const parseTagsJson = parseJsonStringArray;

function replaceNoteAliases(
  db: DB,
  noteId: number,
  aliases: readonly string[] | null | undefined,
): void {
  db.prepare('DELETE FROM note_aliases WHERE note_id = ?').run(noteId);
  if (!aliases || aliases.length === 0) return;

  const seen = new Set<string>();
  const insert = db.prepare(
    'INSERT OR IGNORE INTO note_aliases (note_id, alias, alias_norm) VALUES (?, ?, ?)',
  );

  for (const alias of aliases) {
    if (typeof alias !== 'string') continue;
    const normalized = normalizeAlias(alias);
    const dedupeKey = `${alias}\u0000${normalized}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    insert.run(noteId, alias, normalized);
  }
}

function rebuildAliasLookup(db: DB): void {
  db.prepare('DELETE FROM note_aliases').run();

  const notes = db
    .prepare('SELECT id, aliases FROM notes WHERE aliases IS NOT NULL')
    .all() as Array<{
    id: number;
    aliases: string;
  }>;

  for (const note of notes) {
    replaceNoteAliases(db, note.id, parseAliasesJson(note.aliases));
  }
}

function replaceNoteTags(db: DB, noteId: number, tags: readonly string[] | null | undefined): void {
  db.prepare('DELETE FROM note_tags WHERE note_id = ?').run(noteId);
  if (!tags || tags.length === 0) return;

  const seen = new Set<string>();
  const insert = db.prepare(
    'INSERT OR IGNORE INTO note_tags (note_id, tag, tag_norm) VALUES (?, ?, ?)',
  );

  for (const tag of tags) {
    if (typeof tag !== 'string') continue;
    const normalized = normalizeTag(tag);
    const dedupeKey = `${tag}\u0000${normalized}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    insert.run(noteId, tag, normalized);
  }
}

function rebuildTagLookup(db: DB): void {
  db.prepare('DELETE FROM note_tags').run();

  const notes = db.prepare('SELECT id, tags FROM notes WHERE tags IS NOT NULL').all() as Array<{
    id: number;
    tags: string;
  }>;

  for (const note of notes) {
    replaceNoteTags(db, note.id, parseTagsJson(note.tags));
  }
}

function runMigrations(db: DB): void {
  // Base schema — no FTS tables here; they are managed by the versioned migration below
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id      INTEGER PRIMARY KEY,
      path    TEXT UNIQUE NOT NULL,
      title   TEXT,
      tags    TEXT,
      content TEXT,
      mtime   REAL,
      hash    TEXT
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id               INTEGER PRIMARY KEY,
      note_id          INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      chunk_index      INTEGER NOT NULL,
      text             TEXT NOT NULL,
      heading_path     TEXT,
      embedding_status TEXT NOT NULL DEFAULT 'ok'
    );

    CREATE TABLE IF NOT EXISTS links (
      from_path TEXT NOT NULL,
      to_path   TEXT NOT NULL,
      PRIMARY KEY (from_path, to_path)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS event_log (
      id        INTEGER PRIMARY KEY,
      action    TEXT NOT NULL,
      path      TEXT NOT NULL,
      timestamp TEXT NOT NULL
    );
  `);

  // Query-path indexes for graph traversal and per-note chunk access.
  // links(from_path, to_path) is already covered by the PRIMARY KEY.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_links_to ON links(to_path);
    CREATE INDEX IF NOT EXISTS idx_chunks_note_chunk_index ON chunks(note_id, chunk_index);
  `);

  // Ensure db_version counter exists (cross-process cache invalidation)
  db.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES('db_version', '0')").run();

  // Incremental column migrations
  const cols = db.prepare('PRAGMA table_info(notes)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'aliases')) {
    db.exec('ALTER TABLE notes ADD COLUMN aliases TEXT');
  }
  if (!cols.some((c) => c.name === 'frontmatter')) {
    db.exec("ALTER TABLE notes ADD COLUMN frontmatter TEXT NOT NULL DEFAULT ''");
  }

  const chunkCols = db.prepare('PRAGMA table_info(chunks)').all() as { name: string }[];
  if (!chunkCols.some((c) => c.name === 'embedding_status')) {
    db.exec("ALTER TABLE chunks ADD COLUMN embedding_status TEXT NOT NULL DEFAULT 'ok'");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS note_aliases (
      note_id    INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      alias      TEXT NOT NULL,
      alias_norm TEXT NOT NULL,
      PRIMARY KEY (note_id, alias)
    );

    CREATE INDEX IF NOT EXISTS idx_note_aliases_alias_norm ON note_aliases(alias_norm);

    CREATE TABLE IF NOT EXISTS note_tags (
      note_id  INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      tag      TEXT NOT NULL,
      tag_norm TEXT NOT NULL,
      PRIMARY KEY (note_id, tag)
    );

    CREATE INDEX IF NOT EXISTS idx_note_tags_tag_norm ON note_tags(tag_norm);
  `);

  const aliasLookupVersion = (
    db.prepare("SELECT value FROM settings WHERE key = 'alias_lookup_version'").get() as
      | { value: string }
      | undefined
  )?.value;

  if (aliasLookupVersion !== '1') {
    const tx = db.transaction(() => {
      rebuildAliasLookup(db);
      db.prepare(
        "INSERT OR REPLACE INTO settings(key, value) VALUES('alias_lookup_version', '1')",
      ).run();
    });
    tx();
  }

  const tagLookupVersion = (
    db.prepare("SELECT value FROM settings WHERE key = 'tag_lookup_version'").get() as
      | { value: string }
      | undefined
  )?.value;

  if (tagLookupVersion !== '1') {
    const tx = db.transaction(() => {
      rebuildTagLookup(db);
      db.prepare(
        "INSERT OR REPLACE INTO settings(key, value) VALUES('tag_lookup_version', '1')",
      ).run();
    });
    tx();
  }

  // FTS schema v3: unicode61 tokenchars '+#' so C++/C# are full tokens.
  // Drop and recreate whenever the stored version doesn't match — the FTS
  // index is rebuilt from the notes table so no vault reindex is needed.
  const ftsVersion = (
    db.prepare("SELECT value FROM settings WHERE key = 'fts_schema_version'").get() as
      | { value: string }
      | undefined
  )?.value;

  if (ftsVersion !== '3') {
    db.exec(`
      DROP TABLE IF EXISTS notes_fts_bm25;
      DROP TABLE IF EXISTS notes_fts_fuzzy;
      DROP TRIGGER IF EXISTS notes_ai;
      DROP TRIGGER IF EXISTS notes_au;
      DROP TRIGGER IF EXISTS notes_ad;

      CREATE VIRTUAL TABLE notes_fts_bm25 USING fts5(
        title, aliases, content,
        content='notes', content_rowid='id',
        tokenize = "unicode61 tokenchars '+#'"
      );

      CREATE VIRTUAL TABLE notes_fts_fuzzy USING fts5(
        title, aliases,
        content='notes', content_rowid='id',
        tokenize = 'trigram'
      );

      CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
        INSERT INTO notes_fts_bm25(rowid, title, aliases, content)
          VALUES (new.id, new.title, new.aliases, new.content);
        INSERT INTO notes_fts_fuzzy(rowid, title, aliases)
          VALUES (new.id, new.title, new.aliases);
      END;

      CREATE TRIGGER notes_au AFTER UPDATE ON notes BEGIN
        INSERT INTO notes_fts_bm25(notes_fts_bm25, rowid, title, aliases, content)
          VALUES('delete', old.id, old.title, old.aliases, old.content);
        INSERT INTO notes_fts_bm25(rowid, title, aliases, content)
          VALUES (new.id, new.title, new.aliases, new.content);
        INSERT INTO notes_fts_fuzzy(notes_fts_fuzzy, rowid, title, aliases)
          VALUES('delete', old.id, old.title, old.aliases);
        INSERT INTO notes_fts_fuzzy(rowid, title, aliases)
          VALUES (new.id, new.title, new.aliases);
      END;

      CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
        INSERT INTO notes_fts_bm25(notes_fts_bm25, rowid, title, aliases, content)
          VALUES('delete', old.id, old.title, old.aliases, old.content);
        INSERT INTO notes_fts_fuzzy(notes_fts_fuzzy, rowid, title, aliases)
          VALUES('delete', old.id, old.title, old.aliases);
      END;

      INSERT INTO notes_fts_bm25(notes_fts_bm25) VALUES('rebuild');
      INSERT INTO notes_fts_fuzzy(notes_fts_fuzzy) VALUES('rebuild');

      INSERT OR REPLACE INTO settings(key, value) VALUES('fts_schema_version', '3');
    `);
  }
}

function logEvent(action: 'added' | 'updated' | 'deleted', notePath: string): void {
  const db = getDb();
  db.prepare('INSERT INTO event_log (action, path, timestamp) VALUES (?, ?, ?)').run(
    action,
    notePath,
    new Date().toISOString(),
  );
  // Keep only the 15 most recent events
  db.prepare(
    'DELETE FROM event_log WHERE id NOT IN (SELECT id FROM event_log ORDER BY id DESC LIMIT 15)',
  ).run();
}

function deleteVecChunksForNote(db: DB, noteId: number): void {
  db.prepare(
    'DELETE FROM vec_chunks WHERE chunk_id IN (SELECT id FROM chunks WHERE note_id = ?)',
  ).run(noteId);
}

function cleanupNfcPaths(db: DB): void {
  const vecExists = !!db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vec_chunks'")
    .get();
  const nfcNotes = db.prepare('SELECT id, path FROM notes').all() as { id: number; path: string }[];
  for (const note of nfcNotes) {
    if (note.path !== note.path.normalize('NFD')) {
      if (vecExists) {
        deleteVecChunksForNote(db, note.id);
      }
      db.prepare('DELETE FROM links WHERE from_path = ?').run(note.path);
      db.prepare('DELETE FROM notes WHERE id = ?').run(note.id);
    }
  }
}

function restoreIgnorePatterns(db: DB): void {
  if (!process.env.OBSIDIAN_IGNORE_PATTERNS) {
    const stored = db.prepare("SELECT value FROM settings WHERE key = 'ignore_patterns'").get() as
      | { value: string }
      | undefined;
    if (stored?.value) {
      try {
        const patterns = JSON.parse(stored.value) as string[];
        process.env.OBSIDIAN_IGNORE_PATTERNS = patterns.join(',');
      } catch {
        // Invalid JSON, ignore
      }
    }
  }
}

export function openDb(): DB {
  const db = new Database(config.dbPath);
  sqliteVec.load(db);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  cleanupNfcPaths(db);
  restoreIgnorePatterns(db);
  _db = db;
  return db;
}

export function getDb(): DB {
  if (!_db) throw new Error('Database not initialized. Call openDb() first.');
  return _db;
}

/**
 * Close the current DB connection (if open) and delete all DB files
 * (.db, .db-shm, .db-wal). Safe to call when no connection is open.
 * After this call _db is null — caller must openDb() before using the DB again.
 */
export function wipeDatabaseFiles(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
  const dbPath = config.dbPath;
  for (const ext of ['', '-shm', '-wal']) {
    try {
      unlinkSync(dbPath + ext);
    } catch {
      // File doesn't exist — ok
    }
  }
}

export function initVecTable(dim: number): void {
  const db = getDb();

  const stored = db.prepare("SELECT value FROM settings WHERE key = 'embedding_dim'").get() as
    | { value: string }
    | undefined;
  const storedDim = stored ? parseInt(stored.value) : null;

  const vecExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vec_chunks'")
    .get();

  if (vecExists && storedDim === dim) return;

  if (vecExists) {
    db.exec('DROP TABLE IF EXISTS vec_chunks');
    // Clear chunks too since vectors are gone
    db.exec('DELETE FROM chunks');
  }

  db.exec(`CREATE VIRTUAL TABLE vec_chunks USING vec0(
    chunk_id INTEGER PRIMARY KEY,
    embedding float[${dim}]
  )`);

  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('embedding_dim', ?)").run(
    String(dim),
  );
}

/**
 * Read the embedding vector dimension stored in the settings table.
 * Returns null if the DB has never been indexed (first run) or the value is invalid.
 * Use this to avoid an API round-trip on startup when the dimension is already known.
 */
export function getStoredEmbeddingDim(): number | null {
  const db = getDb();
  const stored = db.prepare("SELECT value FROM settings WHERE key = 'embedding_dim'").get() as
    | { value: string }
    | undefined;
  if (!stored) return null;
  const dim = parseInt(stored.value, 10);
  return dim > 0 ? dim : null;
}

export function hasVecTable(): boolean {
  const db = getDb();
  return !!db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vec_chunks'")
    .get();
}

/**
 * Return the stored Float32Array embeddings for all indexed chunks of a note.
 * Results are ordered by chunk_index. Returns [] if the note has no indexed chunks.
 */
export function getChunkEmbeddingsByPath(notePath: string): Float32Array[] {
  if (!hasVecTable()) return [];
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT vc.embedding
       FROM vec_chunks vc
       JOIN chunks c ON c.id = vc.chunk_id
       JOIN notes n ON n.id = c.note_id
       WHERE n.path = ?
       ORDER BY c.chunk_index`,
    )
    .all(notePath) as { embedding: Buffer }[];
  return rows.map(
    (r) => new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4),
  );
}

interface NoteMeta {
  mtime: number;
  hash: string;
}

interface NoteRow {
  id: number;
  path: string;
  title: string;
  tags: string;
  aliases: string | null;
  content: string;
  frontmatter: string;
  mtime: number;
  hash: string;
}

export function getNoteMeta(path: string): NoteMeta | undefined {
  const db = getDb();
  return db.prepare('SELECT mtime, hash FROM notes WHERE path = ?').get(path) as
    | NoteMeta
    | undefined;
}

export function getNoteByPath(path: string): NoteRow | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM notes WHERE path = ?').get(path) as NoteRow | undefined;
}

export function upsertNote(note: {
  path: string;
  title: string;
  tags: string[];
  aliases?: string[];
  content: string;
  frontmatter?: string;
  mtime: number;
  hash: string;
  chunks: { text: string; headingPath?: string | null; embedding: Float32Array | null }[];
}): void {
  const db = getDb();
  const aliases = note.aliases?.filter((alias): alias is string => typeof alias === 'string') ?? [];
  const aliasesJson = aliases.length > 0 ? JSON.stringify(aliases) : null;

  const existing = db.prepare('SELECT id FROM notes WHERE path = ?').get(note.path) as
    | { id: number }
    | undefined;

  if (existing) {
    // Delete existing chunk vectors before cascade-deleting chunks
    deleteVecChunksForNote(db, existing.id);

    db.prepare(
      `
      UPDATE notes SET title = ?, tags = ?, aliases = ?, content = ?, frontmatter = ?, mtime = ?, hash = ?
      WHERE path = ?
    `,
    ).run(
      note.title,
      JSON.stringify(note.tags),
      aliasesJson,
      note.content,
      note.frontmatter ?? '',
      note.mtime,
      note.hash,
      note.path,
    );

    db.prepare('DELETE FROM chunks WHERE note_id = ?').run(existing.id);

    const noteId = existing.id;
    replaceNoteAliases(db, noteId, aliases);
    replaceNoteTags(db, noteId, note.tags);
    insertChunks(db, noteId, note.chunks);
    logEvent('updated', note.path);
    bumpDbVersion();
  } else {
    const result = db
      .prepare(
        `
      INSERT INTO notes (path, title, tags, aliases, content, frontmatter, mtime, hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        note.path,
        note.title,
        JSON.stringify(note.tags),
        aliasesJson,
        note.content,
        note.frontmatter ?? '',
        note.mtime,
        note.hash,
      );

    const noteId = result.lastInsertRowid as number;
    replaceNoteAliases(db, noteId, aliases);
    replaceNoteTags(db, noteId, note.tags);
    insertChunks(db, noteId, note.chunks);
    logEvent('added', note.path);
    bumpDbVersion();
  }
}

function insertChunks(
  db: DB,
  noteId: number,
  chunks: { text: string; headingPath?: string | null; embedding: Float32Array | null }[],
): void {
  const insertChunk = db.prepare(
    'INSERT INTO chunks (note_id, chunk_index, text, heading_path, embedding_status) VALUES (?, ?, ?, ?, ?)',
  );
  const insertVec = db.prepare('INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)');

  for (let i = 0; i < chunks.length; i++) {
    const { text, headingPath, embedding } = chunks[i]!;
    const status = embedding !== null ? 'ok' : 'failed';
    const result = insertChunk.run(noteId, i, text, headingPath ?? null, status);
    if (embedding !== null) {
      // sqlite-vec vec0 requires INTEGER (BigInt), not REAL (JS number)
      const chunkId = BigInt(result.lastInsertRowid);
      insertVec.run(chunkId, embedding);
    }
  }
}

/**
 * Remove a note from the index.
 * keepLinks=true: preserve link entries (file still exists on disk, just no longer indexed)
 * keepLinks=false (default): also remove all links — use when file is deleted from disk
 */
export function deleteNote(notePath: string, keepLinks = false): void {
  const db = getDb();
  const note = db.prepare('SELECT id FROM notes WHERE path = ?').get(notePath) as
    | { id: number }
    | undefined;
  if (!note) return;

  deleteVecChunksForNote(db, note.id);
  db.prepare('DELETE FROM chunks WHERE note_id = ?').run(note.id);

  if (!keepLinks) {
    db.prepare('DELETE FROM links WHERE from_path = ? OR to_path = ?').run(notePath, notePath);
  }
  db.prepare('DELETE FROM notes WHERE id = ?').run(note.id);
  logEvent('deleted', notePath);
  bumpDbVersion();
}

/**
 * Returns the current DB mutation version — incremented on every note upsert or delete.
 * Used as part of the search cache key so that any process (MCP server, plugin server,
 * CLI) that modifies the DB automatically invalidates the caches of all other processes.
 */
export function getDbVersion(): number {
  const db = getDb();
  const row = db.prepare("SELECT value FROM settings WHERE key = 'db_version'").get() as
    | { value: string }
    | undefined;
  return row ? parseInt(row.value) : 0;
}

function bumpDbVersion(): void {
  const db = getDb();
  db.prepare(
    "INSERT OR REPLACE INTO settings(key, value) VALUES('db_version', CAST(COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'db_version'), 0) + 1 AS TEXT))",
  ).run();
}

export function getOutgoingLinks(notePath: string): string[] {
  const db = getDb();
  const rows = db.prepare('SELECT to_path FROM links WHERE from_path = ?').all(notePath) as {
    to_path: string;
  }[];
  return rows.map((r) => r.to_path);
}

export function getOutgoingLinksForPaths(paths: string[]): Map<string, string[]> {
  if (paths.length === 0) return new Map();

  const db = getDb();
  const placeholders = paths.map(() => '?').join(', ');
  const outgoing = db
    .prepare(`SELECT from_path, to_path FROM links WHERE from_path IN (${placeholders})`)
    .all(...paths) as { from_path: string; to_path: string }[];

  const links = new Map<string, string[]>();
  for (const path of paths) links.set(path, []);
  for (const { from_path, to_path } of outgoing) {
    links.get(from_path)!.push(to_path);
  }
  return links;
}

export function getBacklinksForPaths(paths: string[]): Map<string, string[]> {
  if (paths.length === 0) return new Map();

  const db = getDb();
  const placeholders = paths.map(() => '?').join(', ');
  const incoming = db
    .prepare(`SELECT from_path, to_path FROM links WHERE to_path IN (${placeholders})`)
    .all(...paths) as { from_path: string; to_path: string }[];

  const backlinks = new Map<string, string[]>();
  for (const path of paths) backlinks.set(path, []);
  for (const { from_path, to_path } of incoming) {
    backlinks.get(to_path)!.push(from_path);
  }
  return backlinks;
}

export function upsertLinks(fromPath: string, toPaths: string[]): void {
  const db = getDb();
  db.prepare('DELETE FROM links WHERE from_path = ?').run(fromPath);
  const insert = db.prepare('INSERT OR IGNORE INTO links (from_path, to_path) VALUES (?, ?)');
  for (const toPath of toPaths) {
    insert.run(fromPath, toPath);
  }
}

export function getLinksForPaths(paths: string[]): {
  links: Map<string, string[]>;
  backlinks: Map<string, string[]>;
} {
  if (paths.length === 0) return { links: new Map(), backlinks: new Map() };
  return {
    links: getOutgoingLinksForPaths(paths),
    backlinks: getBacklinksForPaths(paths),
  };
}

export function filterNotePathsByTag(paths: string[], tag: string | string[]): Set<string> {
  if (paths.length === 0) return new Set();

  const db = getDb();
  const filters = Array.isArray(tag) ? tag : [tag];
  const includes = filters.filter((t) => !t.startsWith('-')).map(normalizeTag);
  const excludes = filters.filter((t) => t.startsWith('-')).map((t) => normalizeTag(t.slice(1)));
  const pathPlaceholders = paths.map(() => '?').join(', ');

  const buildTagPredicate = (values: string[]): { sql: string; params: string[] } => {
    const parts: string[] = [];
    const params: string[] = [];
    for (const value of values) {
      parts.push('(nt.tag_norm = ? OR nt.tag_norm LIKE ?)');
      params.push(value, `%${value}%`);
    }
    return {
      sql: parts.length > 0 ? parts.join(' OR ') : '0',
      params,
    };
  };

  const excludePredicate = buildTagPredicate(excludes);
  const includePredicate = buildTagPredicate(includes);

  const includeClause =
    includes.length === 0
      ? '1'
      : `EXISTS (
           SELECT 1
           FROM note_tags nt
           WHERE nt.note_id = n.id
             AND (${includePredicate.sql})
         )`;
  const excludeClause =
    excludes.length === 0
      ? '1'
      : `NOT EXISTS (
           SELECT 1
           FROM note_tags nt
           WHERE nt.note_id = n.id
             AND (${excludePredicate.sql})
         )`;

  const rows = db
    .prepare(
      `SELECT n.path
       FROM notes n
       WHERE n.path IN (${pathPlaceholders})
         AND ${excludeClause}
         AND ${includeClause}`,
    )
    .all(...paths, ...excludePredicate.params, ...includePredicate.params) as Array<{
    path: string;
  }>;

  return new Set(rows.map((row) => row.path));
}

interface EventLogEntry {
  action: 'added' | 'updated' | 'deleted';
  path: string;
  timestamp: string;
}

export function getStats(): {
  total: number;
  indexed: number;
  pending: number;
  chunks: number;
  failedChunks: number;
  links: number;
  lastIndexed: string | null;
  embeddingModel: string | null;
  embeddingDim: number | null;
  dbSizeBytes: number | null;
  recentActivity: EventLogEntry[];
} {
  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) as c FROM notes').get() as { c: number }).c;
  const indexed = (
    db.prepare('SELECT COUNT(DISTINCT note_id) as c FROM chunks').get() as { c: number }
  ).c;
  const chunks = (db.prepare('SELECT COUNT(*) as c FROM chunks').get() as { c: number }).c;
  const failedChunks = (
    db.prepare("SELECT COUNT(*) as c FROM chunks WHERE embedding_status = 'failed'").get() as {
      c: number;
    }
  ).c;
  const links = (db.prepare('SELECT COUNT(*) as c FROM links').get() as { c: number }).c;
  const lastIndexed =
    (
      db.prepare("SELECT value FROM settings WHERE key = 'last_indexed'").get() as
        | { value: string }
        | undefined
    )?.value ?? null;
  const embeddingModel =
    (
      db.prepare("SELECT value FROM settings WHERE key = 'embedding_model'").get() as
        | { value: string }
        | undefined
    )?.value ?? null;
  const storedDim = (
    db.prepare("SELECT value FROM settings WHERE key = 'embedding_dim'").get() as
      | { value: string }
      | undefined
  )?.value;
  const embeddingDim = storedDim !== undefined ? parseInt(storedDim, 10) : null;
  const recentActivity = db
    .prepare('SELECT action, path, timestamp FROM event_log ORDER BY id DESC LIMIT 15')
    .all() as EventLogEntry[];

  let dbSizeBytes: number | null = null;
  try {
    dbSizeBytes = statSync(config.dbPath).size;
  } catch {
    // DB file not accessible
  }

  return {
    total,
    indexed,
    pending: total - indexed,
    chunks,
    failedChunks,
    links,
    lastIndexed,
    embeddingModel,
    embeddingDim,
    dbSizeBytes,
    recentActivity,
  };
}

/**
 * Returns paths of notes that should be removed because they now match ignore patterns.
 * Stores new patterns in settings. Returns empty array if patterns unchanged.
 */
export function getPathsToRemoveForIgnoreChange(patterns: string[]): string[] {
  const db = getDb();
  const key = 'ignore_patterns';
  const stored = db.prepare(`SELECT value FROM settings WHERE key = '${key}'`).get() as
    | { value: string }
    | undefined;
  const newJson = JSON.stringify([...patterns].sort((a, b) => a.localeCompare(b)));

  if (stored && stored.value === newJson) return [];

  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('${key}', ?)`).run(newJson);

  if (!stored) {
    // No stored patterns — check if DB has notes
    // If yes, this is a "reset" scenario, need to filter by new patterns
    // If no, this is truly a first run
    const noteCount = (db.prepare('SELECT COUNT(*) as c FROM notes').get() as { c: number }).c;
    if (noteCount === 0) return [];
  }

  // Return all DB paths that match the new ignore patterns
  const allPaths = (db.prepare('SELECT path FROM notes').all() as { path: string }[])
    .map((r) => r.path)
    .filter((p) => isIgnored(p));
  return allPaths;
}

export function saveConfigMeta(meta: {
  vaultPath: string;
  apiBaseUrl: string;
  apiModel: string;
}): void {
  const db = getDb();
  const set = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  set.run('vault_path', meta.vaultPath);
  set.run('api_base_url', meta.apiBaseUrl);
  set.run('api_model', meta.apiModel);
}

const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/**
 * Bootstrap process.env from DB settings saved during the last reindex.
 * Called at server startup so the plugin subprocess inherits the correct
 * embedding endpoint (e.g. Ollama) without requiring the user to duplicate
 * env vars in Obsidian's GUI launch environment.
 * Env vars already set by the caller always take precedence.
 */
export function applyDbConfigDefaults(): void {
  const db = getDb();
  const get = (key: string): string | undefined =>
    (
      db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
        | { value: string }
        | undefined
    )?.value;

  if (!process.env.OPENAI_BASE_URL) {
    const storedUrl = get('api_base_url');
    // Only apply non-default URLs (Ollama, OpenRouter, etc.).
    // Setting OPENAI_BASE_URL to the OpenAI default without an API key
    // would switch embedder into API mode and fail immediately.
    if (storedUrl && storedUrl !== OPENAI_DEFAULT_BASE_URL) {
      process.env.OPENAI_BASE_URL = storedUrl;
    }
  }

  if (!process.env.OPENAI_EMBEDDING_MODEL) {
    const storedModel = get('api_model');
    if (storedModel) {
      process.env.OPENAI_EMBEDDING_MODEL = storedModel;
    }
  }
}

export function updateLastIndexed(): void {
  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('last_indexed', ?)").run(
    new Date().toISOString(),
  );
}

/**
 * Check if the embedding model has changed since last run.
 * If it has, delete all DB files and start fresh so the schema is rebuilt
 * with the correct vector dimensions.
 * Returns true if the model changed (caller should force-reindex).
 */
export function getStoredModel(): string | null {
  const db = getDb();
  const row = db.prepare("SELECT value FROM settings WHERE key = 'embedding_model'").get() as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function checkModelChanged(model: string): boolean {
  const db = getDb();
  const stored = db.prepare("SELECT value FROM settings WHERE key = 'embedding_model'").get() as
    | { value: string }
    | undefined;

  if (stored?.value === model) return false;

  if (!stored) {
    // First run — just store the model name, no wipe needed
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('embedding_model', ?)").run(
      model,
    );
    return false;
  }

  // Model changed — drop all DB files and recreate from scratch
  process.stderr.write(`Embedding model changed: ${stored.value} → ${model}\n`);
  wipeDatabaseFiles();
  openDb();
  getDb()
    .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('embedding_model', ?)")
    .run(model);
  return true;
}
