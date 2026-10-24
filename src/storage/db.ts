import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import * as sqliteVec from 'sqlite-vec';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import { CONTENT_POLICY_IDENTITY, type SourcePart } from '../content/content-ignore.js';
import { normalizeNotePath, normalizeTag } from '../content/text-normalization.js';
import { config } from '../runtime/config.js';
import { getIgnoreSignature, isIgnored } from '../vault/ignore.js';

import {
  createIndexOwnership,
  IndexLeaseLostError,
  type IndexLease,
  type IndexOwnerMode,
  type IndexOwnershipStore,
  type IndexOwnerSnapshot,
  type IndexProgress,
  type StalledOwner,
} from './index-ownership.js';

type DB = InstanceType<typeof Database>;

let _db: DB | null = null;
let _ownership: IndexOwnershipStore | null = null;

const CORRUPTION_CODES = new Set(['SQLITE_CORRUPT', 'SQLITE_CORRUPT_VTAB', 'SQLITE_NOTADB']);
const NON_CORRUPTION_CODES = new Set(['SQLITE_BUSY', 'SQLITE_LOCKED']);
const CORRUPTION_MESSAGE_RE =
  /database disk image is malformed|file is not a database|malformed database schema|database corruption|database is corrupt/i;
const NON_CORRUPTION_MESSAGE_RE =
  /database is locked|database table is locked|SQLITE_BUSY|SQLITE_LOCKED/i;

function errorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object' || !('code' in err)) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function isLikelyDatabaseCorruption(err: unknown): boolean {
  const code = errorCode(err);
  if (code && NON_CORRUPTION_CODES.has(code)) return false;
  if (code && CORRUPTION_CODES.has(code)) return true;

  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : String(err);
  if (NON_CORRUPTION_MESSAGE_RE.test(message)) return false;
  return CORRUPTION_MESSAGE_RE.test(message);
}

function normalizeAlias(alias: string): string {
  return alias.normalize('NFD').toLowerCase();
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

function extractFrontmatterFields(
  data: Record<string, unknown>,
  prefix = '',
): Array<{ field: string; value: string }> {
  const fields: Array<{ field: string; value: string }> = [];

  if (!data || typeof data !== 'object') return fields;

  for (const [key, value] of Object.entries(data)) {
    if (!key || key.trim() === '') continue;
    const fieldName = prefix ? `${prefix}.${key}` : key;

    if (value === null || value === undefined) continue;

    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
          const strValue = String(item);
          if (strValue.trim()) {
            fields.push({ field: fieldName, value: strValue });
          }
        } else if (typeof item === 'object' && item !== null) {
          fields.push(...extractFrontmatterFields(item as Record<string, unknown>, fieldName));
        }
      }
    } else if (typeof value === 'object') {
      fields.push(...extractFrontmatterFields(value as Record<string, unknown>, fieldName));
    } else if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      const strValue = String(value);
      if (strValue.trim()) {
        fields.push({ field: fieldName, value: strValue });
      }
    }
  }

  return fields;
}

function replaceNoteFrontmatterFields(
  db: DB,
  noteId: number,
  frontmatter: Record<string, unknown> | null | undefined,
): void {
  db.prepare('DELETE FROM note_frontmatter_fields WHERE note_id = ?').run(noteId);
  if (!frontmatter || Object.keys(frontmatter).length === 0) return;

  let fields: Array<{ field: string; value: string }>;
  try {
    fields = extractFrontmatterFields(frontmatter);
  } catch (e) {
    console.error('Error extracting frontmatter fields:', e);
    return;
  }
  if (fields.length === 0) return;

  const insert = db.prepare(
    'INSERT OR IGNORE INTO note_frontmatter_fields (note_id, field, value, value_norm) VALUES (?, ?, ?, ?)',
  );

  for (const { field, value } of fields) {
    if (!field || !value) continue;
    insert.run(noteId, field, value, value.toLowerCase());
  }
}

function rebuildFrontmatterLookup(db: DB): void {
  db.prepare('DELETE FROM note_frontmatter_fields').run();

  const notes = db
    .prepare(
      "SELECT id, frontmatter FROM notes WHERE frontmatter IS NOT NULL AND frontmatter != ''",
    )
    .all() as Array<{
    id: number;
    frontmatter: string;
  }>;

  for (const note of notes) {
    let data: Record<string, unknown>;
    try {
      const parsed = note.frontmatter
        .split('\n')
        .filter((line) => line.trim() && !line.startsWith('---'))
        .join('\n');
      data = parsed ? (yamlParse(parsed) as Record<string, unknown>) : {};
    } catch (error) {
      console.error('Error parsing frontmatter for note', note.id, error);
      continue;
    }
    if (data && typeof data === 'object') replaceNoteFrontmatterFields(db, note.id, data);
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

    CREATE TABLE IF NOT EXISTS markdown_links (
      from_path TEXT NOT NULL,
      to_path   TEXT NOT NULL,
      PRIMARY KEY (from_path, to_path)
    );

    CREATE TABLE IF NOT EXISTS note_urls (
      from_path TEXT NOT NULL,
      url       TEXT NOT NULL,
      position  INTEGER NOT NULL,
      PRIMARY KEY (from_path, url)
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
    CREATE INDEX IF NOT EXISTS idx_markdown_links_to ON markdown_links(to_path);
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
  if (!cols.some((c) => c.name === 'embedding_context')) {
    db.exec('ALTER TABLE notes ADD COLUMN embedding_context TEXT');
  }

  const chunkCols = db.prepare('PRAGMA table_info(chunks)').all() as { name: string }[];
  if (!chunkCols.some((c) => c.name === 'embedding_status')) {
    db.exec("ALTER TABLE chunks ADD COLUMN embedding_status TEXT NOT NULL DEFAULT 'ok'");
  }
  if (!chunkCols.some((c) => c.name === 'char_start')) {
    db.exec('ALTER TABLE chunks ADD COLUMN char_start INTEGER');
  }
  if (!chunkCols.some((c) => c.name === 'char_end')) {
    db.exec('ALTER TABLE chunks ADD COLUMN char_end INTEGER');
  }
  if (!chunkCols.some((c) => c.name === 'source_spans')) {
    db.exec('ALTER TABLE chunks ADD COLUMN source_spans TEXT');
  }

  // Partial index for fast --errors lookups (only indexes failed rows)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chunks_failed ON chunks(embedding_status) WHERE embedding_status = 'failed'
  `);

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
      { value: string } | undefined
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
      { value: string } | undefined
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

  db.exec(`
    CREATE TABLE IF NOT EXISTS note_frontmatter_fields (
      note_id  INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      field    TEXT NOT NULL,
      value    TEXT NOT NULL,
      value_norm TEXT NOT NULL,
      PRIMARY KEY (note_id, field, value)
    );

    CREATE INDEX IF NOT EXISTS idx_fm_field_value_norm ON note_frontmatter_fields(field, value_norm);
  `);

  const fmLookupVersion = (
    db.prepare("SELECT value FROM settings WHERE key = 'frontmatter_lookup_version'").get() as
      { value: string } | undefined
  )?.value;

  if (fmLookupVersion !== '1') {
    rebuildFrontmatterLookup(db);
    db.prepare(
      "INSERT OR REPLACE INTO settings(key,value) VALUES('frontmatter_lookup_version','1')",
    ).run();
  }

  // FTS schema v3: unicode61 tokenchars '+#' so C++/C# are full tokens.
  // Drop and recreate whenever the stored version doesn't match — the FTS
  // index is rebuilt from the notes table so no vault reindex is needed.
  const ftsVersion = (
    db.prepare("SELECT value FROM settings WHERE key = 'fts_schema_version'").get() as
      { value: string } | undefined
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

function cleanupNfcPaths(db: DB): boolean {
  let changed = false;
  const vecExists = !!db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vec_chunks'")
    .get();
  const nfcNotes = db.prepare('SELECT id, path FROM notes').all() as { id: number; path: string }[];
  for (const note of nfcNotes) {
    if (note.path !== normalizeNotePath(note.path)) {
      if (vecExists) {
        deleteVecChunksForNote(db, note.id);
      }
      db.prepare('DELETE FROM chunks WHERE note_id = ?').run(note.id);
      deleteChildRows(db, note.id);
      db.prepare('DELETE FROM links WHERE from_path = ? OR to_path = ?').run(note.path, note.path);
      db.prepare('DELETE FROM markdown_links WHERE from_path = ? OR to_path = ?').run(
        note.path,
        note.path,
      );
      db.prepare('DELETE FROM note_urls WHERE from_path = ?').run(note.path);
      db.prepare('DELETE FROM notes WHERE id = ?').run(note.id);
      changed = true;
    }
  }
  return changed;
}

function restoreIgnorePatterns(db: DB): void {
  if (process.env.OBSIDIAN_IGNORE_PATTERNS === undefined) {
    const stored = db.prepare("SELECT value FROM settings WHERE key = 'ignore_patterns'").get() as
      { value: string } | undefined;
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

export class IndexInitializationBusyError extends Error {
  constructor() {
    super('Another process is initializing this index. Waiting for it to finish.');
    this.name = 'IndexInitializationBusyError';
  }
}

export class IndexStorageError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'IndexStorageError';
  }
}

export function openDb(): DB {
  closeDb();
  const db = new Database(config.dbPath, { timeout: 250 });
  try {
    sqliteVec.load(db);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    _db = db;
    _ownership = createIndexOwnership(db);
    const settingsExist = db.prepare("SELECT 1 FROM sqlite_master WHERE name='settings'").get();
    const revision = settingsExist
      ? (db.prepare("SELECT value FROM settings WHERE key='index_ownership_schema'").get() as
          { value: string } | undefined)
      : undefined;
    if (revision?.value !== '1') {
      const lease = _ownership.claim(randomUUID(), 'bootstrap');
      if (!lease) throw new IndexInitializationBusyError();
      try {
        _ownership.write(lease, () => {
          runMigrations(db);
          db.exec(`
            CREATE TABLE IF NOT EXISTS index_repair_notes(path TEXT PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS index_failures (
              path TEXT NOT NULL, operation TEXT NOT NULL, fingerprint TEXT NOT NULL,
              code TEXT, message TEXT NOT NULL, attempts INTEGER NOT NULL,
              last_failed_at TEXT NOT NULL, PRIMARY KEY(path, operation)
            );
          `);
          db.prepare(
            "INSERT OR REPLACE INTO settings(key,value) VALUES('index_ownership_schema','1')",
          ).run();
        });
      } finally {
        _ownership.release(lease);
      }
    }
    restoreIgnorePatterns(db);
    return db;
  } catch (err) {
    _ownership = null;
    _db = null;
    db.close();
    throw err;
  }
}

function ownership(): IndexOwnershipStore {
  getDb();
  if (!_ownership) throw new Error('Index ownership is not initialized.');
  return _ownership;
}

export function readIndexOwner(): IndexOwnerSnapshot {
  return ownership().read();
}
export function requestForegroundIndex(token: string): void {
  ownership().requestForeground(token);
}
export function renewForegroundIndexRequest(token: string): boolean {
  return ownership().renewForegroundRequest(token);
}
export function cancelForegroundIndexRequest(token: string): void {
  ownership().cancelForegroundRequest(token);
}
export function claimIndexLease(
  token: string,
  mode: IndexOwnerMode,
  stalled?: StalledOwner,
): IndexLease | null {
  return ownership().claim(token, mode, stalled);
}
export function renewIndexLease(lease: IndexLease, progress?: IndexProgress): boolean {
  return ownership().renew(lease, progress);
}
export function releaseIndexLease(lease: IndexLease): boolean {
  return ownership().release(lease);
}
export function withIndexMutation<T>(lease: IndexLease, operation: () => T): T {
  try {
    return ownership().write(lease, operation);
  } catch (error) {
    if (!(error instanceof IndexLeaseLostError) && isLikelyDatabaseCorruption(error)) {
      throw new IndexStorageError(error);
    }
    throw error;
  }
}

export function reopenDatabaseForRecovery(lease: IndexLease): void {
  openDb();
  withIndexMutation(lease, () => undefined);
}

export function cleanupLegacyPaths(lease: IndexLease): void {
  withIndexMutation(lease, () => {
    if (cleanupNfcPaths(getDb())) bumpDbVersion();
  });
}

export function getDb(): DB {
  if (!_db) throw new Error('Database not initialized. Call openDb() first.');
  return _db;
}

export function closeDb(): void {
  if (!_db) return;
  _db.close();
  _db = null;
  _ownership = null;
}

export function initVecTable(lease: IndexLease, dim: number): void {
  return withIndexMutation(lease, () => {
    const db = getDb();
    if (hasVecTable()) return;
    if (!Number.isSafeInteger(dim) || dim <= 0) {
      throw new Error(`Embedding dimension must be a positive safe integer: ${dim}`);
    }
    const initialize = db.transaction(() => {
      if (hasVecTable()) return;
      db.exec(`CREATE VIRTUAL TABLE vec_chunks USING vec0(
      chunk_id INTEGER PRIMARY KEY,
      embedding float[${dim}]
    )`);
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('embedding_dim', ?)").run(
        String(dim),
      );
    });
    initialize.immediate();
  });
}

/**
 * Read the embedding vector dimension stored in the settings table.
 * Returns null if the DB has never been indexed (first run) or the value is invalid.
 * Use this to avoid an API round-trip on startup when the dimension is already known.
 */
export function getStoredEmbeddingDim(): number | null {
  const db = getDb();
  const stored = db.prepare("SELECT value FROM settings WHERE key = 'embedding_dim'").get() as
    { value: string } | undefined;
  if (!stored) return null;
  const dim = Number(stored.value);
  return Number.isSafeInteger(dim) && dim > 0 ? dim : null;
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
  return getChunkEmbeddingSourceByPath(notePath).embeddings;
}

/** Capture source vectors and their provenance from the same SQLite snapshot. */
export function getChunkEmbeddingSourceByPath(notePath: string): {
  embeddings: Float32Array[];
  modelName: string | null;
} {
  const db = getDb();
  return db
    .transaction(() => {
      const modelName = getStoredModel();
      if (!hasVecTable()) return { embeddings: [], modelName };
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
      return {
        modelName,
        embeddings: rows.map(
          (r) =>
            new Float32Array(
              r.embedding.buffer,
              r.embedding.byteOffset,
              r.embedding.byteLength / 4,
            ),
        ),
      };
    })
    .deferred();
}

export class EmbeddingModelMismatchError extends Error {
  override name = 'EmbeddingModelMismatchError';
}

/** Call inside the transaction that consumes the vectors. Never infer legacy provenance. */
export function assertEmbeddingModelCompatible(modelName: string | null): void {
  const storedModel = getStoredModel();
  if (storedModel !== null && modelName === storedModel) return;
  if (!hasVecTable() || !getDb().prepare('SELECT 1 FROM vec_chunks LIMIT 1').get()) return;
  if (storedModel === null || modelName === null) {
    throw new EmbeddingModelMismatchError(
      'Embedding model is unknown for existing vectors or the similarity source. Existing index preserved; use full reindex --force to rebuild with the configured model.',
    );
  }
  throw new EmbeddingModelMismatchError(
    `Embedding model mismatch: index uses "${storedModel}", search uses "${modelName}". Existing index preserved; restore the indexed model configuration, or use full reindex --force for an intentional rebuild.`,
  );
}

/** SQLite caps bound parameters per statement; batch path lists well under it. */
export const PATH_BATCH_SIZE = 500;

function batchPaths(paths: string[]): string[][] {
  const batches: string[][] = [];
  for (let i = 0; i < paths.length; i += PATH_BATCH_SIZE) {
    batches.push(paths.slice(i, i + PATH_BATCH_SIZE));
  }
  return batches;
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

export type NotePathResolution =
  { type: 'resolved'; path: string } | { type: 'ambiguous'; candidates: string[] };

export function getNoteMeta(path: string): NoteMeta | undefined {
  const db = getDb();
  return db
    .prepare(
      'SELECT mtime, hash FROM notes WHERE path = ? AND NOT EXISTS (SELECT 1 FROM index_repair_notes WHERE path=notes.path)',
    )
    .get(path) as NoteMeta | undefined;
}

export function getNoteByPath(path: string): NoteRow | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM notes WHERE path = ?').get(path) as NoteRow | undefined;
}

export function resolveNotePath(input: string): NotePathResolution | undefined {
  const db = getDb();
  const normalized = normalizeNotePath(input);
  const exact = getNoteByPath(normalized);
  if (exact) return { type: 'resolved', path: exact.path };

  if (!normalized.endsWith('.md')) {
    const withExtension = `${normalized}.md`;
    const withExtensionNote = getNoteByPath(withExtension);
    if (withExtensionNote) return { type: 'resolved', path: withExtensionNote.path };
  }

  const inputFileName = normalized.split('/').pop() ?? normalized;
  const basename = inputFileName.endsWith('.md') ? inputFileName.slice(0, -3) : inputFileName;
  if (!basename) return undefined;

  const rows = db
    .prepare('SELECT path FROM notes WHERE path = ? OR path LIKE ? ORDER BY path')
    .all(`${basename}.md`, `%/${basename}.md`) as { path: string }[];

  if (rows.length === 0) return undefined;
  if (rows.length === 1) return { type: 'resolved', path: rows[0]!.path };
  return { type: 'ambiguous', candidates: rows.map((row) => row.path) };
}

export interface PreparedIndexNote {
  path: string;
  title: string;
  tags: string[];
  aliases?: string[];
  content: string;
  frontmatter?: Record<string, unknown>;
  mtime: number;
  hash: string;
  embeddingContext?: string | null;
  chunks: {
    text: string;
    headingPath?: string | null;
    embedding: Float32Array | null;
    charStart?: number | null;
    charEnd?: number | null;
    sourceSpans?: readonly SourcePart[] | null;
  }[];
}

export function upsertNote(
  lease: IndexLease,
  note: PreparedIndexNote,
  context?: { modelName: string; contentPolicySignature?: string },
): void {
  return withIndexMutation(lease, () => {
    const db = getDb();
    const write = db.transaction(() => {
      const desiredPolicy = context?.contentPolicySignature ?? CONTENT_POLICY_IDENTITY;
      const policyMismatch = context && getActiveContentPolicySignature() !== desiredPolicy;
      const empty =
        policyMismatch &&
        !db.prepare('SELECT 1 FROM notes LIMIT 1').get() &&
        !db.prepare('SELECT 1 FROM chunks LIMIT 1').get();
      if (policyMismatch && !empty)
        throw new Error(
          'Content policy mismatch. Existing index preserved; restart with the intended configuration or reindex.',
        );
      const storedModel = getStoredModel();
      if (storedModel && context && storedModel !== context.modelName) {
        throw new Error(
          `Embedding model mismatch: index uses "${storedModel}", writer uses "${context.modelName}". Update not committed; existing index preserved. Restore the indexed model configuration, or use full reindex --force for an intentional rebuild.`,
        );
      }
      const actual = hasVecTable()
        ? (db.prepare('SELECT vec_length(embedding) AS dim FROM vec_chunks LIMIT 1').get() as
            { dim: number } | undefined)
        : undefined;
      if (actual && !storedModel && context) {
        throw new Error(
          'Embedding model is unknown for existing vectors. Update not committed; existing index preserved. Use full reindex --force to rebuild with the configured model.',
        );
      }
      const storedDim = getStoredEmbeddingDim();
      if (actual && storedDim !== null && actual.dim !== storedDim) {
        throw new Error(
          `Embedding dimension metadata mismatch: stored ${storedDim}, vectors ${actual.dim}. Update not committed; existing index preserved.`,
        );
      }
      const expectedDim = actual?.dim ?? storedDim;
      for (const chunk of note.chunks) {
        if (
          chunk.embedding !== null &&
          expectedDim !== null &&
          chunk.embedding.length !== expectedDim
        ) {
          throw new Error(
            `Embedding dimension mismatch: expected ${expectedDim}, received ${chunk.embedding.length}. Update not committed; existing index preserved.`,
          );
        }
      }
      const fresh = !storedModel && context !== undefined && !actual;

      const aliases =
        note.aliases?.filter((alias): alias is string => typeof alias === 'string') ?? [];
      const aliasesJson = aliases.length > 0 ? JSON.stringify(aliases) : null;

      const existing = db.prepare('SELECT id FROM notes WHERE path = ?').get(note.path) as
        { id: number } | undefined;

      const fmString = note.frontmatter ? yamlStringify(note.frontmatter) : '';

      if (existing) {
        // Delete existing chunk vectors before cascade-deleting chunks
        deleteVecChunksForNote(db, existing.id);

        db.prepare(
          `
      UPDATE notes SET title = ?, tags = ?, aliases = ?, content = ?, frontmatter = ?, mtime = ?, hash = ?, embedding_context = ?
      WHERE path = ?
    `,
        ).run(
          note.title,
          JSON.stringify(note.tags),
          aliasesJson,
          note.content,
          fmString,
          note.mtime,
          note.hash,
          note.embeddingContext ?? null,
          note.path,
        );

        db.prepare('DELETE FROM chunks WHERE note_id = ?').run(existing.id);

        const noteId = existing.id;
        replaceNoteAliases(db, noteId, aliases);
        replaceNoteTags(db, noteId, note.tags);
        replaceNoteFrontmatterFields(db, noteId, note.frontmatter);
        insertChunks(db, noteId, note.chunks);
        logEvent('updated', note.path);
        bumpDbVersion();
      } else {
        const result = db
          .prepare(
            `
      INSERT INTO notes (path, title, tags, aliases, content, frontmatter, mtime, hash, embedding_context)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
          )
          .run(
            note.path,
            note.title,
            JSON.stringify(note.tags),
            aliasesJson,
            note.content,
            fmString,
            note.mtime,
            note.hash,
            note.embeddingContext ?? null,
          );

        const noteId = result.lastInsertRowid as number;
        replaceNoteAliases(db, noteId, aliases);
        replaceNoteTags(db, noteId, note.tags);
        replaceNoteFrontmatterFields(db, noteId, note.frontmatter);
        insertChunks(db, noteId, note.chunks);
        logEvent('added', note.path);
        bumpDbVersion();
      }
      if (fresh && note.chunks.some((chunk) => chunk.embedding !== null)) {
        db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('embedding_model', ?)").run(
          context.modelName,
        );
      }
      if (empty)
        db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES ('content_policy',?)").run(
          desiredPolicy,
        );
    });
    write.immediate();
  });
}

function insertChunks(db: DB, noteId: number, chunks: PreparedIndexNote['chunks']): void {
  const insertChunk = db.prepare(
    'INSERT INTO chunks (note_id, chunk_index, text, heading_path, embedding_status, char_start, char_end, source_spans) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const insertVec = db.prepare('INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)');

  for (let i = 0; i < chunks.length; i++) {
    const { text, headingPath, embedding, charStart, charEnd, sourceSpans } = chunks[i]!;
    validateChunkSourceSpans(chunks[i]!);
    const status = embedding !== null ? 'ok' : 'failed';
    const result = insertChunk.run(
      noteId,
      i,
      text,
      headingPath ?? null,
      status,
      charStart ?? null,
      charEnd ?? null,
      sourceSpans ? JSON.stringify(sourceSpans) : null,
    );
    if (embedding !== null) {
      // sqlite-vec vec0 requires INTEGER (BigInt), not REAL (JS number)
      const chunkId = BigInt(result.lastInsertRowid);
      insertVec.run(chunkId, embedding);
    }
  }
}

/** Validate persisted discontiguous anchors without retaining a second source body. */
export function validateChunkSourceSpans(chunk: PreparedIndexNote['chunks'][number]): void {
  const spans = chunk.sourceSpans;
  if (spans == null) return;
  const { charStart, charEnd, text } = chunk;
  const invalid = () => new Error('Invalid chunk source spans; existing index preserved.');
  if (
    !Array.isArray(spans) ||
    !Number.isInteger(charStart) ||
    !Number.isInteger(charEnd) ||
    charStart == null ||
    charEnd == null ||
    charStart < 0 ||
    charEnd <= charStart
  )
    throw invalid();
  let previous = charStart;
  let length = 0;
  for (const span of spans) {
    if (span === ' ' || span === '\n') {
      if (text[length] !== span) throw invalid();
      length++;
    } else {
      if (
        !Array.isArray(span) ||
        span.length !== 2 ||
        !Number.isInteger(span[0]) ||
        !Number.isInteger(span[1]) ||
        span[0]! < previous ||
        span[1]! <= span[0]! ||
        span[1]! > charEnd
      )
        throw invalid();
      length += span[1]! - span[0]!;
      previous = Number(span[1]);
    }
  }
  if (length === 0 || length !== text.length) throw invalid();
}

/**
 * Remove a note from the index.
 * keepLinks=true: preserve link entries (file still exists on disk, just no longer indexed)
 * keepLinks=false (default): also remove all links — use when file is deleted from disk
 */
// Explicit cleanup of all child tables — defensive against schema drift
// where older DBs may lack ON DELETE CASCADE
function deleteChildRows(db: DB, noteId: number): void {
  db.prepare('DELETE FROM note_aliases WHERE note_id = ?').run(noteId);
  db.prepare('DELETE FROM note_tags WHERE note_id = ?').run(noteId);
  db.prepare('DELETE FROM note_frontmatter_fields WHERE note_id = ?').run(noteId);
}

export function deleteNote(lease: IndexLease, notePath: string, keepLinks = false): void {
  return withIndexMutation(lease, () => {
    const db = getDb();
    const note = db.prepare('SELECT id FROM notes WHERE path = ?').get(notePath) as
      { id: number } | undefined;
    clearIndexFailures(lease, notePath);
    if (!note) return;

    deleteChildRows(db, note.id);
    deleteVecChunksForNote(db, note.id);
    db.prepare('DELETE FROM chunks WHERE note_id = ?').run(note.id);

    if (!keepLinks) {
      db.prepare('DELETE FROM links WHERE from_path = ? OR to_path = ?').run(notePath, notePath);
      db.prepare('DELETE FROM markdown_links WHERE from_path = ? OR to_path = ?').run(
        notePath,
        notePath,
      );
    }
    db.prepare('DELETE FROM note_urls WHERE from_path = ?').run(notePath);
    db.prepare('DELETE FROM notes WHERE id = ?').run(note.id);
    logEvent('deleted', notePath);
    bumpDbVersion();
  });
}

/**
 * Returns the current DB mutation version — incremented on every note upsert or delete.
 * Used as part of the search cache key so that any process (MCP server, plugin server,
 * CLI) that modifies the DB automatically invalidates the caches of all other processes.
 */
export function getDbVersion(): number {
  const db = getDb();
  const row = db.prepare("SELECT value FROM settings WHERE key = 'db_version'").get() as
    { value: string } | undefined;
  return row ? parseInt(row.value) : 0;
}

function bumpDbVersion(): void {
  const db = getDb();
  db.prepare(
    "INSERT OR REPLACE INTO settings(key, value) VALUES('db_version', CAST(COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'db_version'), 0) + 1 AS TEXT))",
  ).run();
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

export function upsertLinks(lease: IndexLease, fromPath: string, toPaths: string[]): boolean {
  return withIndexMutation(lease, () => {
    const db = getDb();
    const desired = [...new Set(toPaths)];
    const existing = db
      .prepare('SELECT to_path FROM links WHERE from_path = ? ORDER BY rowid')
      .pluck()
      .all(fromPath);
    if (
      existing.length === desired.length &&
      existing.every((value, index) => value === desired[index])
    )
      return false;
    db.prepare('DELETE FROM links WHERE from_path = ?').run(fromPath);
    const insert = db.prepare('INSERT OR IGNORE INTO links (from_path, to_path) VALUES (?, ?)');
    for (const toPath of desired) {
      insert.run(fromPath, toPath);
    }
    return true;
  });
}

export function upsertMarkdownLinks(
  lease: IndexLease,
  fromPath: string,
  toPaths: string[],
): boolean {
  return withIndexMutation(lease, () => {
    const db = getDb();
    const desired = [...new Set(toPaths)];
    const existing = db
      .prepare('SELECT to_path FROM markdown_links WHERE from_path = ? ORDER BY rowid')
      .pluck()
      .all(fromPath);
    if (
      existing.length === desired.length &&
      existing.every((value, index) => value === desired[index])
    )
      return false;
    db.prepare('DELETE FROM markdown_links WHERE from_path = ?').run(fromPath);
    const insert = db.prepare(
      'INSERT OR IGNORE INTO markdown_links (from_path, to_path) VALUES (?, ?)',
    );
    for (const toPath of desired) {
      insert.run(fromPath, toPath);
    }
    return true;
  });
}

export function upsertNoteUrls(lease: IndexLease, fromPath: string, urls: string[]): boolean {
  return withIndexMutation(lease, () => {
    const db = getDb();
    const desired = [...new Set(urls)];
    const existing = db
      .prepare('SELECT url FROM note_urls WHERE from_path = ? ORDER BY position')
      .pluck()
      .all(fromPath);
    if (
      existing.length === desired.length &&
      existing.every((value, index) => value === desired[index])
    )
      return false;
    db.prepare('DELETE FROM note_urls WHERE from_path = ?').run(fromPath);
    const insert = db.prepare(
      'INSERT OR IGNORE INTO note_urls (from_path, url, position) VALUES (?, ?, ?)',
    );
    for (const [position, url] of desired.entries()) {
      insert.run(fromPath, url, position);
    }
    return true;
  });
}

export function getMarkdownLinksForPaths(paths: string[]): {
  links: Map<string, string[]>;
  backlinks: Map<string, string[]>;
} {
  const links = new Map<string, string[]>();
  const backlinks = new Map<string, string[]>();
  for (const path of paths) {
    links.set(path, []);
    backlinks.set(path, []);
  }
  if (paths.length === 0) return { links, backlinks };

  const db = getDb();
  const placeholders = paths.map(() => '?').join(', ');
  const outgoing = db
    .prepare(
      `SELECT from_path, to_path FROM markdown_links WHERE from_path IN (${placeholders}) ORDER BY from_path ASC, to_path ASC`,
    )
    .all(...paths) as { from_path: string; to_path: string }[];
  for (const { from_path, to_path } of outgoing) {
    links.get(from_path)!.push(to_path);
  }

  const incoming = db
    .prepare(
      `SELECT from_path, to_path FROM markdown_links WHERE to_path IN (${placeholders}) ORDER BY to_path ASC, from_path ASC`,
    )
    .all(...paths) as { from_path: string; to_path: string }[];
  for (const { from_path, to_path } of incoming) {
    backlinks.get(to_path)!.push(from_path);
  }

  return { links, backlinks };
}

export function getUrlsForPaths(paths: string[]): Map<string, string[]> {
  const urls = new Map<string, string[]>();
  for (const path of paths) urls.set(path, []);
  if (paths.length === 0) return urls;

  const db = getDb();
  const placeholders = paths.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT from_path, url FROM note_urls WHERE from_path IN (${placeholders}) ORDER BY from_path ASC, position ASC, url ASC`,
    )
    .all(...paths) as { from_path: string; url: string }[];
  for (const { from_path, url } of rows) {
    urls.get(from_path)!.push(url);
  }
  return urls;
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

  // Multiple include tags = AND logic (note must have ALL specified tags)
  const includeExistsClauses: string[] = [];
  const includeExistsParams: string[] = [];
  for (const value of includes) {
    includeExistsClauses.push(
      'EXISTS (SELECT 1 FROM note_tags nt WHERE nt.note_id = n.id AND (nt.tag_norm = ? OR nt.tag_norm LIKE ?))',
    );
    includeExistsParams.push(value, `%${value}%`);
  }
  const includeClause = includeExistsClauses.length > 0 ? includeExistsClauses.join(' AND ') : '1';

  // Multiple exclude tags = AND logic (note must NOT have ANY of the excluded tags)
  const excludeNotExistsClauses: string[] = [];
  const excludeNotExistsParams: string[] = [];
  for (const value of excludes) {
    excludeNotExistsClauses.push(
      'NOT EXISTS (SELECT 1 FROM note_tags nt WHERE nt.note_id = n.id AND (nt.tag_norm = ? OR nt.tag_norm LIKE ?))',
    );
    excludeNotExistsParams.push(value, `%${value}%`);
  }
  const excludeClause =
    excludeNotExistsClauses.length > 0 ? excludeNotExistsClauses.join(' AND ') : '1';

  // Batched: callers may pass the entire vault (resolveFilteredPaths does), and one
  // bound parameter per path would blow SQLITE_MAX_VARIABLE_NUMBER on a large vault.
  const matched = new Set<string>();
  for (const batch of batchPaths(paths)) {
    const pathPlaceholders = batch.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT n.path
       FROM notes n
       WHERE n.path IN (${pathPlaceholders})
         AND ${excludeClause}
         AND ${includeClause}`,
      )
      .all(...batch, ...excludeNotExistsParams, ...includeExistsParams) as Array<{
      path: string;
    }>;
    for (const row of rows) matched.add(row.path);
  }

  return matched;
}

export function filterNotePathsByFrontmatter(
  paths: string[],
  frontmatter: string | string[],
): Set<string> {
  if (paths.length === 0) return new Set();

  const db = getDb();
  const filters = Array.isArray(frontmatter) ? frontmatter : [frontmatter];
  const includes = filters.filter((f) => !f.startsWith('-'));
  const excludes = filters.filter((f) => f.startsWith('-')).map((f) => f.slice(1));

  // Multiple include filters = AND logic (note must have ALL specified field values)
  const includeExistsClauses: string[] = [];
  const includeExistsParams: string[] = [];
  for (const value of includes) {
    const colonIdx = value.indexOf(':');
    if (colonIdx === -1) continue;
    const field = value.slice(0, colonIdx).toLowerCase();
    const fieldValue = value.slice(colonIdx + 1).toLowerCase();
    includeExistsClauses.push(
      'EXISTS (SELECT 1 FROM note_frontmatter_fields f WHERE f.note_id = n.id AND f.field = ? AND f.value_norm = ?)',
    );
    includeExistsParams.push(field, fieldValue);
  }

  // If there were includes but none had a valid "field:value" format, return nothing
  if (includes.length > 0 && includeExistsClauses.length === 0) return new Set();

  const includeClause = includeExistsClauses.length > 0 ? includeExistsClauses.join(' AND ') : '1';

  // Exclude = AND logic (note must NOT have ANY of the excluded field values)
  const excludeNotExistsClauses: string[] = [];
  const excludeNotExistsParams: string[] = [];
  for (const value of excludes) {
    const colonIdx = value.indexOf(':');
    if (colonIdx === -1) continue;
    const field = value.slice(0, colonIdx).toLowerCase();
    const fieldValue = value.slice(colonIdx + 1).toLowerCase();
    excludeNotExistsClauses.push(
      'NOT EXISTS (SELECT 1 FROM note_frontmatter_fields f WHERE f.note_id = n.id AND f.field = ? AND f.value_norm = ?)',
    );
    excludeNotExistsParams.push(field, fieldValue);
  }

  const excludeClause =
    excludeNotExistsClauses.length > 0 ? excludeNotExistsClauses.join(' AND ') : '1';

  // Batched for the same reason as filterNotePathsByTag: the path set may be the
  // whole vault, which would otherwise exceed SQLite's bound-parameter limit.
  const matched = new Set<string>();
  for (const batch of batchPaths(paths)) {
    const pathPlaceholders = batch.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT n.path
       FROM notes n
       WHERE n.path IN (${pathPlaceholders})
         AND ${excludeClause}
         AND ${includeClause}`,
      )
      .all(...batch, ...excludeNotExistsParams, ...includeExistsParams) as Array<{
      path: string;
    }>;
    for (const row of rows) matched.add(row.path);
  }

  return matched;
}

export function getMatchingNotesByFrontmatter(
  frontmatter: string | string[],
  limit: number,
): Array<{ path: string; title: string; tags: string; aliases: string | null }> {
  const db = getDb();
  const filters = Array.isArray(frontmatter) ? frontmatter : [frontmatter];
  const includes = filters.filter((f) => !f.startsWith('-'));
  const excludes = filters.filter((f) => f.startsWith('-')).map((f) => f.slice(1));

  // Multiple include filters = AND logic (note must have ALL specified field values)
  const includeExistsClauses: string[] = [];
  const includeExistsParams: string[] = [];
  for (const value of includes) {
    const colonIdx = value.indexOf(':');
    if (colonIdx === -1) continue;
    const field = value.slice(0, colonIdx).toLowerCase();
    const fieldValue = value.slice(colonIdx + 1).toLowerCase();
    includeExistsClauses.push(
      'EXISTS (SELECT 1 FROM note_frontmatter_fields f WHERE f.note_id = n.id AND f.field = ? AND f.value_norm = ?)',
    );
    includeExistsParams.push(field, fieldValue);
  }

  // If there were includes but none had a valid "field:value" format, return nothing
  if (includes.length > 0 && includeExistsClauses.length === 0) return [];

  const includeClause = includeExistsClauses.length > 0 ? includeExistsClauses.join(' AND ') : '1';

  // Exclude = AND logic (note must NOT have ANY of the excluded field values)
  const excludeNotExistsClauses: string[] = [];
  const excludeNotExistsParams: string[] = [];
  for (const value of excludes) {
    const colonIdx = value.indexOf(':');
    if (colonIdx === -1) continue;
    const field = value.slice(0, colonIdx).toLowerCase();
    const fieldValue = value.slice(colonIdx + 1).toLowerCase();
    excludeNotExistsClauses.push(
      'NOT EXISTS (SELECT 1 FROM note_frontmatter_fields f WHERE f.note_id = n.id AND f.field = ? AND f.value_norm = ?)',
    );
    excludeNotExistsParams.push(field, fieldValue);
  }

  const excludeClause =
    excludeNotExistsClauses.length > 0 ? excludeNotExistsClauses.join(' AND ') : '1';

  const rows = db
    .prepare(
      `SELECT n.path, n.title, n.tags, n.aliases
       FROM notes n
       WHERE ${excludeClause}
         AND ${includeClause}
       ORDER BY n.title ASC
       LIMIT ?`,
    )
    .all(...excludeNotExistsParams, ...includeExistsParams, limit) as Array<{
    path: string;
    title: string;
    tags: string;
    aliases: string | null;
  }>;

  return rows;
}

interface EventLogEntry {
  action: 'added' | 'updated' | 'deleted';
  path: string;
  timestamp: string;
}

export function getStats(): {
  total: number;
  indexed: number;
  withoutChunks: number;
  chunks: number;
  failedChunks: number;
  failedIndexing: number;
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
        { value: string } | undefined
    )?.value ?? null;
  const embeddingModel =
    (
      db.prepare("SELECT value FROM settings WHERE key = 'embedding_model'").get() as
        { value: string } | undefined
    )?.value ?? null;
  const storedDim = (
    db.prepare("SELECT value FROM settings WHERE key = 'embedding_dim'").get() as
      { value: string } | undefined
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
    withoutChunks: total - indexed,
    chunks,
    failedChunks,
    failedIndexing: Number(db.prepare('SELECT count(*) FROM index_failures').pluck().get()),
    links,
    lastIndexed,
    embeddingModel,
    embeddingDim,
    dbSizeBytes,
    recentActivity,
  };
}

export interface FailedChunk {
  path: string;
  title: string;
  chunkIndex: number;
  headingPath: string | null;
  text: string;
}

export function getFailedChunks(limit = 100): FailedChunk[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT n.path, n.title, c.chunk_index, c.heading_path, c.text
       FROM chunks c
       JOIN notes n ON n.id = c.note_id
       WHERE c.embedding_status = 'failed'
       ORDER BY n.path, c.chunk_index
       LIMIT ?`,
    )
    .all(limit) as FailedChunk[];
}

/**
 * Vault-relative paths of notes with a rolled-back write or rejected embedding.
 * Unlike getFailedChunks this is unbounded, because it drives a repair pass that
 * must cover every affected note rather than a preview.
 */
export function getNotesNeedingRepair(): string[] {
  return (
    getDb()
      .prepare(
        `SELECT path FROM index_failures WHERE operation='index' AND path<>''
    UNION SELECT n.path FROM notes n JOIN chunks c ON c.note_id=n.id WHERE c.embedding_status='failed'
    ORDER BY path`,
      )
      .all() as Array<{ path: string }>
  ).map((row) => row.path);
}

/**
 * Returns paths of notes that should be removed because they now match ignore patterns.
 * Stores new patterns in settings. Returns empty array if patterns unchanged.
 */
export function cleanupIgnoredNotes(
  lease: IndexLease,
  patterns: string[],
  signature = getIgnoreSignature(),
  isIgnoredPath: (path: string) => boolean = isIgnored,
): string[] {
  return withIndexMutation(lease, () => {
    const paths = pathsForIgnoreChange(patterns, signature, isIgnoredPath);
    for (const notePath of paths) deleteNote(lease, notePath, true);
    return paths;
  });
}

function pathsForIgnoreChange(
  patterns: string[],
  signature = getIgnoreSignature(),
  isIgnoredPath: (path: string) => boolean = isIgnored,
): string[] {
  const db = getDb();
  const patternsKey = 'ignore_patterns';
  const signatureKey = 'ignore_state_signature';
  const storedPatterns = db
    .prepare(`SELECT value FROM settings WHERE key = '${patternsKey}'`)
    .get() as { value: string } | undefined;
  const stored = db.prepare(`SELECT value FROM settings WHERE key = '${signatureKey}'`).get() as
    { value: string } | undefined;
  const storedSignature = storedPatterns ? stored : undefined;
  const patternsJson = JSON.stringify([...patterns].sort((a, b) => a.localeCompare(b)));

  if (storedSignature && storedSignature.value === signature) return [];

  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('${patternsKey}', ?)`).run(
    patternsJson,
  );
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('${signatureKey}', ?)`).run(
    signature,
  );

  if (!storedSignature) {
    // No stored patterns — check if DB has notes
    // If yes, this is a "reset" scenario, need to filter by new patterns
    // If no, this is truly a first run
    const noteCount = (db.prepare('SELECT COUNT(*) as c FROM notes').get() as { c: number }).c;
    if (noteCount === 0) return [];
  }

  // Return all DB paths that match the new ignore patterns
  const allPaths = (db.prepare('SELECT path FROM notes').all() as { path: string }[])
    .map((r) => r.path)
    .filter((p) => isIgnoredPath(p));
  return allPaths;
}

export function saveConfigMeta(
  lease: IndexLease,
  meta: {
    vaultPath: string;
    apiBaseUrl: string;
    apiModel: string;
  },
): void {
  return withIndexMutation(lease, () => {
    const db = getDb();
    const set = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    set.run('vault_path', meta.vaultPath);
    set.run('api_base_url', meta.apiBaseUrl);
    set.run('api_model', meta.apiModel);
  });
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
        { value: string } | undefined
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

export function updateLastIndexed(lease: IndexLease): void {
  return withIndexMutation(lease, () => {
    const db = getDb();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('last_indexed', ?)").run(
      new Date().toISOString(),
    );
  });
}

/** Return recorded index provenance without adopting the current configuration. */
export function getStoredModel(): string | null {
  const db = getDb();
  const row = db.prepare("SELECT value FROM settings WHERE key = 'embedding_model'").get() as
    { value: string } | undefined;
  return row?.value ?? null;
}

export function getActiveContentPolicySignature(): string {
  return (
    (getDb().prepare("SELECT value FROM settings WHERE key='content_policy'").pluck().get() as
      string | undefined) ?? CONTENT_POLICY_IDENTITY
  );
}

export interface NoteReferences {
  links: string[];
  markdownLinks: string[];
  urls: string[];
}

export function clearIndexFailures(lease: IndexLease, notePath: string, operation?: string): void {
  withIndexMutation(lease, () => {
    if (operation)
      getDb()
        .prepare('DELETE FROM index_failures WHERE path=? AND operation=?')
        .run(notePath, operation);
    else getDb().prepare('DELETE FROM index_failures WHERE path=?').run(notePath);
    getDb().prepare('DELETE FROM index_repair_notes WHERE path=?').run(notePath);
  });
}

export function commitIndexedNote(
  lease: IndexLease,
  note: PreparedIndexNote,
  context: { modelName: string; contentPolicySignature?: string },
  references: NoteReferences,
): void {
  withIndexMutation(lease, () => {
    upsertNote(lease, note, context);
    upsertLinks(lease, note.path, references.links);
    upsertMarkdownLinks(lease, note.path, references.markdownLinks);
    upsertNoteUrls(lease, note.path, references.urls);
    clearIndexFailures(lease, note.path);
  });
}

export function repairIndexIntegrity(lease: IndexLease): {
  removedVectors: number;
  repairPaths: string[];
} {
  // Validate even an empty/no-vector database before deciding there is no work.
  withIndexMutation(lease, () => undefined);
  if (!hasVecTable()) return { removedVectors: 0, repairPaths: [] };
  let removedVectors = 0;
  for (;;) {
    const removed = withIndexMutation(lease, () => {
      const db = getDb();
      const orphans = db
        .prepare(
          `SELECT v.chunk_id FROM vec_chunks v
        LEFT JOIN chunks c ON c.id=v.chunk_id WHERE c.id IS NULL LIMIT 500`,
        )
        .safeIntegers()
        .all() as Array<{ chunk_id: bigint }>;
      const remove = db.prepare('DELETE FROM vec_chunks WHERE chunk_id=?');
      for (const orphan of orphans) remove.run(orphan.chunk_id);
      if (orphans.length > 0) bumpDbVersion();
      return orphans.length;
    });
    removedVectors += removed;
    if (removed < 500) break;
  }
  const repairPaths = withIndexMutation(lease, () => {
    const db = getDb();
    // Read vector IDs once instead of repeating a virtual-table lookup for every chunk.
    db.prepare(
      `INSERT OR IGNORE INTO index_repair_notes(path)
      SELECT DISTINCT n.path FROM chunks c JOIN notes n ON n.id=c.note_id
      WHERE c.embedding_status='ok'
        AND c.id NOT IN (SELECT chunk_id FROM vec_chunks WHERE chunk_id IS NOT NULL)`,
    ).run();
    return (
      db.prepare('SELECT path FROM index_repair_notes ORDER BY path').all() as Array<{
        path: string;
      }>
    ).map(({ path }) => path);
  });
  return { removedVectors, repairPaths };
}

export interface RebuildTarget {
  modelName: string;
  embeddingDim: number;
  contentPolicySignature?: string;
  metadata: { vaultPath: string; apiBaseUrl: string; apiModel: string };
}

/** Publish prepared rows under one writer lock. Active FTS remains trigger-owned. */
export function replaceActiveIndex(
  lease: IndexLease,
  target: RebuildTarget,
  rows: Iterable<{ note: PreparedIndexNote; references: NoteReferences }>,
): void {
  withIndexMutation(lease, () => {
    const db = getDb();
    const version = getDbVersion();
    db.exec(
      'DELETE FROM links; DELETE FROM markdown_links; DELETE FROM note_urls; DELETE FROM note_aliases; DELETE FROM note_tags; DELETE FROM note_frontmatter_fields;',
    );
    if (hasVecTable()) db.exec('DROP TABLE vec_chunks');
    db.exec(
      'DELETE FROM chunks; DELETE FROM notes; DELETE FROM index_failures; DELETE FROM index_repair_notes;',
    );
    db.prepare("DELETE FROM settings WHERE key IN ('embedding_model','embedding_dim')").run();
    initVecTable(lease, target.embeddingDim);
    const insert = db.prepare(
      'INSERT INTO notes(path,title,tags,aliases,content,frontmatter,mtime,hash,embedding_context) VALUES(?,?,?,?,?,?,?,?,?)',
    );
    const link = db.prepare('INSERT OR IGNORE INTO links(from_path,to_path) VALUES(?,?)');
    const markdown = db.prepare(
      'INSERT OR IGNORE INTO markdown_links(from_path,to_path) VALUES(?,?)',
    );
    const url = db.prepare('INSERT OR IGNORE INTO note_urls(from_path,url,position) VALUES(?,?,?)');
    for (const { note, references } of rows) {
      const aliases = note.aliases ?? [];
      const id = Number(
        insert.run(
          note.path,
          note.title,
          JSON.stringify(note.tags),
          aliases.length ? JSON.stringify(aliases) : null,
          note.content,
          note.frontmatter ? yamlStringify(note.frontmatter) : '',
          note.mtime,
          note.hash,
          note.embeddingContext ?? null,
        ).lastInsertRowid,
      );
      replaceNoteAliases(db, id, aliases);
      replaceNoteTags(db, id, note.tags);
      replaceNoteFrontmatterFields(db, id, note.frontmatter);
      insertChunks(db, id, note.chunks);
      for (const to of references.links) link.run(note.path, to);
      for (const to of references.markdownLinks) markdown.run(note.path, to);
      for (const [position, value] of [...new Set(references.urls)].entries())
        url.run(note.path, value, position);
    }
    const setting = db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)');
    setting.run('embedding_model', target.modelName);
    setting.run('content_policy', target.contentPolicySignature ?? CONTENT_POLICY_IDENTITY);
    setting.run('db_version', String(version + 1));
    saveConfigMeta(lease, target.metadata);
    updateLastIndexed(lease);
  });
}

export interface IndexFailure {
  path: string;
  operation: string;
  code: string;
  message: string;
  attempts: number;
  last_failed_at: string;
}

export function recordIndexFailure(
  lease: IndexLease,
  notePath: string,
  operation: string,
  fingerprint: string,
  error: unknown,
): void {
  withIndexMutation(lease, () => {
    let message = error instanceof Error ? error.message : String(error);
    if (config.apiKey) message = message.split(config.apiKey).join('[redacted]');
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : 'INDEXING_FAILED';
    getDb()
      .prepare(
        `INSERT INTO index_failures(path,operation,fingerprint,code,message,attempts,last_failed_at)
      VALUES(?,?,?,?,?,1,?) ON CONFLICT(path,operation) DO UPDATE SET fingerprint=excluded.fingerprint,
      code=excluded.code,message=excluded.message,attempts=index_failures.attempts+1,last_failed_at=excluded.last_failed_at`,
      )
      .run(
        notePath,
        operation,
        fingerprint,
        code.slice(0, 80),
        message.slice(0, 1000),
        new Date().toISOString(),
      );
  });
}

export function hasIndexFailure(notePath: string, operation: string, fingerprint: string): boolean {
  return !!getDb()
    .prepare('SELECT 1 FROM index_failures WHERE path=? AND operation=? AND fingerprint=?')
    .get(notePath, operation, fingerprint);
}

export function getIndexFailures(): IndexFailure[] {
  return getDb()
    .prepare(
      'SELECT path,operation,code,message,attempts,last_failed_at FROM index_failures ORDER BY last_failed_at DESC,path LIMIT 20',
    )
    .all() as IndexFailure[];
}
