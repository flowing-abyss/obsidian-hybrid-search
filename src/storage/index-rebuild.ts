import { randomUUID } from 'node:crypto';
import { extractMarkdownNote } from '../content/note-extractor.js';
import {
  getDb,
  replaceActiveIndex,
  withIndexMutation,
  type NoteReferences,
  type PreparedIndexNote,
  type RebuildTarget,
} from './db.js';
import type { IndexLease } from './index-ownership.js';

export function discardRebuilds(lease: IndexLease): void {
  withIndexMutation(lease, () => {
    const db = getDb();
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='index_rebuild'").get())
      db.exec('DELETE FROM index_rebuild');
  });
}

export function beginRebuild(lease: IndexLease, target: RebuildTarget): string {
  return withIndexMutation(lease, () => {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS index_rebuild(run_id TEXT PRIMARY KEY, target_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS index_rebuild_notes(run_id TEXT NOT NULL REFERENCES index_rebuild(run_id) ON DELETE CASCADE,
        path TEXT NOT NULL, note_json TEXT NOT NULL, frontmatter_raw TEXT NOT NULL, mtime REAL NOT NULL, size INTEGER NOT NULL,
        references_json TEXT, PRIMARY KEY(run_id,path));
      CREATE TABLE IF NOT EXISTS index_rebuild_chunks(run_id TEXT NOT NULL,path TEXT NOT NULL,ordinal INTEGER NOT NULL,
        chunk_json TEXT NOT NULL,embedding BLOB NOT NULL,PRIMARY KEY(run_id,path,ordinal),
        FOREIGN KEY(run_id,path) REFERENCES index_rebuild_notes(run_id,path) ON DELETE CASCADE);`);
    db.exec('DELETE FROM index_rebuild');
    const id = randomUUID();
    db.prepare('INSERT INTO index_rebuild VALUES(?,?)').run(id, JSON.stringify(target));
    return id;
  });
}

export function stageRebuildNote(
  lease: IndexLease,
  id: string,
  note: PreparedIndexNote,
  frontmatterRaw: string,
  fingerprint: { mtimeMs: number; size: number },
): void {
  withIndexMutation(lease, () => {
    const db = getDb();
    const row = db.prepare('SELECT target_json FROM index_rebuild WHERE run_id=?').get(id) as
      { target_json: string } | undefined;
    if (!row) throw new Error('Rebuild no longer exists');
    const target = JSON.parse(row.target_json) as RebuildTarget;
    for (const chunk of note.chunks) {
      if (
        !chunk.embedding ||
        chunk.embedding.length !== target.embeddingDim ||
        !chunk.embedding.every(Number.isFinite)
      ) {
        throw new Error(
          'Rebuild embedding failed or has an incompatible dimension; existing index preserved.',
        );
      }
    }
    db.prepare('DELETE FROM index_rebuild_notes WHERE run_id=? AND path=?').run(id, note.path);
    const { chunks, ...metadata } = note;
    db.prepare(
      'INSERT INTO index_rebuild_notes(run_id,path,note_json,frontmatter_raw,mtime,size) VALUES(?,?,?,?,?,?)',
    ).run(
      id,
      note.path,
      JSON.stringify({ ...metadata, frontmatter: undefined }),
      frontmatterRaw,
      fingerprint.mtimeMs,
      fingerprint.size,
    );
    const insert = db.prepare('INSERT INTO index_rebuild_chunks VALUES(?,?,?,?,?)');
    for (const [ordinal, chunk] of chunks.entries()) {
      const { embedding, ...rest } = chunk;
      insert.run(id, note.path, ordinal, JSON.stringify(rest), embedding);
    }
  });
}

export function readRebuildNotes(id: string): Array<{
  note: Omit<PreparedIndexNote, 'chunks'>;
  frontmatterRaw: string;
  mtime: number;
  size: number;
}> {
  const rows = getDb()
    .prepare(
      'SELECT note_json,frontmatter_raw,mtime,size FROM index_rebuild_notes WHERE run_id=? ORDER BY rowid',
    )
    .all(id) as Array<{ note_json: string; frontmatter_raw: string; mtime: number; size: number }>;
  return rows.map((row) => ({
    note: JSON.parse(row.note_json) as Omit<PreparedIndexNote, 'chunks'>,
    frontmatterRaw: row.frontmatter_raw,
    mtime: row.mtime,
    size: row.size,
  }));
}

export function removeRebuildNote(lease: IndexLease, id: string, notePath: string): void {
  withIndexMutation(lease, () =>
    getDb().prepare('DELETE FROM index_rebuild_notes WHERE run_id=? AND path=?').run(id, notePath),
  );
}

export function setRebuildReferences(
  lease: IndexLease,
  id: string,
  notePath: string,
  references: NoteReferences,
): void {
  withIndexMutation(lease, () =>
    getDb()
      .prepare('UPDATE index_rebuild_notes SET references_json=? WHERE run_id=? AND path=?')
      .run(JSON.stringify(references), id, notePath),
  );
}

export function publishRebuild(lease: IndexLease, id: string): void {
  withIndexMutation(lease, () => {
    const db = getDb();
    const targetRow = db.prepare('SELECT target_json FROM index_rebuild WHERE run_id=?').get(id) as
      { target_json: string } | undefined;
    if (!targetRow) throw new Error('Rebuild no longer exists');
    function* rows(): Iterable<{ note: PreparedIndexNote; references: NoteReferences }> {
      const metadata = db.prepare(
        'SELECT rowid,path,note_json,frontmatter_raw,references_json FROM index_rebuild_notes WHERE run_id=? AND rowid>? ORDER BY rowid LIMIT 100',
      );
      const chunks = db.prepare(
        'SELECT chunk_json,embedding FROM index_rebuild_chunks WHERE run_id=? AND path=? ORDER BY ordinal',
      );
      let after = 0;
      for (;;) {
        const batch = metadata.all(id, after) as Array<{
          rowid: number;
          path: string;
          note_json: string;
          frontmatter_raw: string;
          references_json: string | null;
        }>;
        if (batch.length === 0) break;
        for (const row of batch) {
          after = row.rowid;
          if (!row.references_json) throw new Error('Rebuild references are incomplete');
          const note = JSON.parse(row.note_json) as PreparedIndexNote;
          // JSON cannot preserve YAML dates or non-finite numbers. Use the same
          // parser as ordinary indexing against the staged source block.
          note.frontmatter = extractMarkdownNote(
            `---${row.frontmatter_raw}\n---\n`,
            note.title,
          ).frontmatter;
          note.chunks = (
            chunks.all(id, row.path) as Array<{ chunk_json: string; embedding: Buffer }>
          ).map((chunk) => ({
            ...(JSON.parse(chunk.chunk_json) as Omit<
              PreparedIndexNote['chunks'][number],
              'embedding'
            >),
            embedding: new Float32Array(
              chunk.embedding.buffer.slice(
                chunk.embedding.byteOffset,
                chunk.embedding.byteOffset + chunk.embedding.byteLength,
              ),
            ),
          }));
          yield { note, references: JSON.parse(row.references_json) as NoteReferences };
        }
      }
    }
    replaceActiveIndex(lease, JSON.parse(targetRow.target_json) as RebuildTarget, rows());
    db.prepare('DELETE FROM index_rebuild WHERE run_id=?').run(id);
  });
}
