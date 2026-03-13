import Database from 'better-sqlite3';
import { statSync } from 'node:fs';
import * as sqliteVec from 'sqlite-vec';
import { config } from './config.js';
import { isIgnored } from './ignore.js';

type DB = InstanceType<typeof Database>;

let _db: DB | null = null;

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

  // Incremental column migrations
  const cols = db.prepare('PRAGMA table_info(notes)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'aliases')) {
    db.exec('ALTER TABLE notes ADD COLUMN aliases TEXT');
  }

  const chunkCols = db.prepare('PRAGMA table_info(chunks)').all() as { name: string }[];
  if (!chunkCols.some((c) => c.name === 'embedding_status')) {
    db.exec("ALTER TABLE chunks ADD COLUMN embedding_status TEXT NOT NULL DEFAULT 'ok'");
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

function cleanupNfcPaths(db: DB): void {
  const vecExists = !!db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vec_chunks'")
    .get();
  const nfcNotes = db.prepare('SELECT id, path FROM notes').all() as { id: number; path: string }[];
  for (const note of nfcNotes) {
    if (note.path !== note.path.normalize('NFD')) {
      if (vecExists) {
        const chunkIds = db.prepare('SELECT id FROM chunks WHERE note_id = ?').all(note.id) as {
          id: number;
        }[];
        for (const { id } of chunkIds) {
          db.prepare('DELETE FROM vec_chunks WHERE chunk_id = ?').run(id);
        }
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
  mtime: number;
  hash: string;
  chunks: { text: string; embedding: Float32Array | null }[];
}): void {
  const db = getDb();
  const aliasesJson = note.aliases && note.aliases.length > 0 ? JSON.stringify(note.aliases) : null;

  const existing = db.prepare('SELECT id FROM notes WHERE path = ?').get(note.path) as
    | { id: number }
    | undefined;

  if (existing) {
    // Delete existing chunk vectors before cascade-deleting chunks
    const chunkIds = db.prepare('SELECT id FROM chunks WHERE note_id = ?').all(existing.id) as {
      id: number;
    }[];
    for (const { id } of chunkIds) {
      db.prepare('DELETE FROM vec_chunks WHERE chunk_id = ?').run(id);
    }

    db.prepare(
      `
      UPDATE notes SET title = ?, tags = ?, aliases = ?, content = ?, mtime = ?, hash = ?
      WHERE path = ?
    `,
    ).run(
      note.title,
      JSON.stringify(note.tags),
      aliasesJson,
      note.content,
      note.mtime,
      note.hash,
      note.path,
    );

    db.prepare('DELETE FROM chunks WHERE note_id = ?').run(existing.id);

    const noteId = existing.id;
    insertChunks(db, noteId, note.chunks);
    logEvent('updated', note.path);
  } else {
    const result = db
      .prepare(
        `
      INSERT INTO notes (path, title, tags, aliases, content, mtime, hash)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        note.path,
        note.title,
        JSON.stringify(note.tags),
        aliasesJson,
        note.content,
        note.mtime,
        note.hash,
      );

    const noteId = result.lastInsertRowid as number;
    insertChunks(db, noteId, note.chunks);
    logEvent('added', note.path);
  }
}

function insertChunks(
  db: DB,
  noteId: number,
  chunks: { text: string; embedding: Float32Array | null }[],
): void {
  const insertChunk = db.prepare(
    'INSERT INTO chunks (note_id, chunk_index, text, embedding_status) VALUES (?, ?, ?, ?)',
  );
  const insertVec = db.prepare('INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)');

  for (let i = 0; i < chunks.length; i++) {
    const { text, embedding } = chunks[i]!;
    const status = embedding !== null ? 'ok' : 'failed';
    const result = insertChunk.run(noteId, i, text, status);
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

  const chunkIds = db.prepare('SELECT id FROM chunks WHERE note_id = ?').all(note.id) as {
    id: number;
  }[];
  for (const { id } of chunkIds) {
    db.prepare('DELETE FROM vec_chunks WHERE chunk_id = ?').run(id);
  }
  db.prepare('DELETE FROM chunks WHERE note_id = ?').run(note.id);

  if (!keepLinks) {
    db.prepare('DELETE FROM links WHERE from_path = ? OR to_path = ?').run(notePath, notePath);
  }
  db.prepare('DELETE FROM notes WHERE id = ?').run(note.id);
  logEvent('deleted', notePath);
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

  const db = getDb();
  const placeholders = paths.map(() => '?').join(', ');

  const outgoing = db
    .prepare(`SELECT from_path, to_path FROM links WHERE from_path IN (${placeholders})`)
    .all(...paths) as { from_path: string; to_path: string }[];

  const incoming = db
    .prepare(`SELECT from_path, to_path FROM links WHERE to_path IN (${placeholders})`)
    .all(...paths) as { from_path: string; to_path: string }[];

  const links = new Map<string, string[]>();
  const backlinks = new Map<string, string[]>();

  for (const path of paths) {
    links.set(path, []);
    backlinks.set(path, []);
  }
  for (const { from_path, to_path } of outgoing) {
    links.get(from_path)!.push(to_path);
  }
  for (const { from_path, to_path } of incoming) {
    backlinks.get(to_path)!.push(from_path);
  }

  return { links, backlinks };
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
  ignorePatternsCsv?: string;
}): void {
  const db = getDb();
  const set = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  set.run('vault_path', meta.vaultPath);
  set.run('api_base_url', meta.apiBaseUrl);
  set.run('api_model', meta.apiModel);
  if (meta.ignorePatternsCsv !== undefined) {
    const patterns = meta.ignorePatternsCsv
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    set.run('ignore_patterns', JSON.stringify(patterns.sort((a, b) => a.localeCompare(b))));
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
 * If it has, wipe all notes, chunks, and vectors so a fresh reindex is forced.
 * Returns true if the model changed (caller should force-reindex).
 */
export function checkModelChanged(model: string): boolean {
  const db = getDb();
  const stored = db.prepare("SELECT value FROM settings WHERE key = 'embedding_model'").get() as
    | { value: string }
    | undefined;

  if (stored?.value === model) {
    return false;
  }

  // Model changed — wipe everything
  db.exec('DROP TABLE IF EXISTS vec_chunks');
  db.exec('DELETE FROM chunks');
  db.exec('DELETE FROM links');
  db.exec('DELETE FROM notes');
  db.exec("DELETE FROM settings WHERE key IN ('embedding_dim', 'last_indexed')");
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('embedding_model', ?)").run(
    model,
  );

  return true;
}
