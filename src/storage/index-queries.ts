import {
  getDb,
  getStoredModel,
  hasVecTable,
  upsertLinks,
  upsertMarkdownLinks,
  upsertNoteUrls,
  withIndexMutation,
} from './db.js';
import type { IndexLease } from './index-ownership.js';

/** Policy-only reuse requires an exact prepared-input proof, not just equal source hashes. */
export function getReusableEmbeddings(request: {
  path: string;
  hash: string;
  title: string;
  content: string;
  embeddingContext: string;
  modelName: string;
  dimension: number;
  chunks: readonly { text: string; headingPath: string | null }[];
}): Float32Array[] | null {
  if (!hasVecTable() || getStoredModel() !== request.modelName) return null;
  const db = getDb();
  const note = db
    .prepare(
      'SELECT id FROM notes WHERE path=? AND hash=? AND title=? AND content=? AND embedding_context=?',
    )
    .get(request.path, request.hash, request.title, request.content, request.embeddingContext) as
    { id: number } | undefined;
  if (!note) return null;
  const rows = db
    .prepare(
      `SELECT c.text,c.heading_path,c.embedding_status,v.embedding FROM chunks c
    LEFT JOIN vec_chunks v ON v.chunk_id=c.id WHERE c.note_id=? ORDER BY c.chunk_index`,
    )
    .all(note.id) as Array<{
    text: string;
    heading_path: string | null;
    embedding_status: string;
    embedding: Buffer | null;
  }>;
  if (rows.length !== request.chunks.length) return null;
  const vectors: Float32Array[] = [];
  for (const [index, row] of rows.entries()) {
    const chunk = request.chunks[index]!;
    if (
      row.text !== chunk.text ||
      row.heading_path !== chunk.headingPath ||
      row.embedding_status !== 'ok' ||
      !row.embedding ||
      row.embedding.byteLength !== request.dimension * 4
    )
      return null;
    const vector = new Float32Array(
      row.embedding.buffer.slice(
        row.embedding.byteOffset,
        row.embedding.byteOffset + row.embedding.byteLength,
      ),
    );
    if (!vector.every(Number.isFinite)) return null;
    vectors.push(vector);
  }
  return vectors;
}

function bumpGraphVersion(): void {
  getDb()
    .prepare(
      "INSERT OR REPLACE INTO settings(key, value) VALUES('db_version', CAST(COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'db_version'), 0) + 1 AS TEXT))",
    )
    .run();
}

export function getExistingNotePathSet(): Set<string> {
  const rows = getDb().prepare('SELECT path FROM notes').all() as { path: string }[];
  return new Set(rows.map((row) => row.path));
}

export function updateNoteMtime(lease: IndexLease, mtime: number, relPath: string): void {
  return withIndexMutation(lease, () => {
    getDb().prepare('UPDATE notes SET mtime = ? WHERE path = ?').run(mtime, relPath);
  });
}

export function storePopulateMissingLinks(
  lease: IndexLease,
  resolveWikilinks: (content: string, fromPath: string) => string[],
): void {
  return withIndexMutation(lease, () => {
    const db = getDb();
    const done = (
      db.prepare("SELECT value FROM settings WHERE key = 'links_v1'").get() as
        { value: string } | undefined
    )?.value;
    if (done) return;

    const notes = db
      .prepare('SELECT path, content, frontmatter FROM notes WHERE content IS NOT NULL')
      .all() as {
      path: string;
      content: string;
      frontmatter: string;
    }[];
    let changed = false;
    for (const note of notes) {
      const links = resolveWikilinks((note.frontmatter || '') + '\n' + note.content, note.path);
      changed = upsertLinks(lease, note.path, links) || changed;
    }

    if (changed) bumpGraphVersion();
    db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES('links_v1', '1')").run();
  });
}

export function storePopulateMissingMarkdownReferences(
  lease: IndexLease,
  resolveMarkdownReferencesForNote: (
    fromPath: string,
    content: string,
    existingPaths: Set<string>,
  ) => { links: string[]; urls: string[] },
): void {
  return withIndexMutation(lease, () => {
    const db = getDb();
    const done = (
      db.prepare("SELECT value FROM settings WHERE key = 'markdown_links_v1'").get() as
        { value: string } | undefined
    )?.value;
    if (done) return;

    const notes = db.prepare('SELECT path, content FROM notes WHERE content IS NOT NULL').all() as {
      path: string;
      content: string;
    }[];
    const existingPaths = new Set(notes.map((note) => note.path));
    const tx = db.transaction(() => {
      let changed = false;
      for (const note of notes) {
        const references = resolveMarkdownReferencesForNote(note.path, note.content, existingPaths);
        changed = upsertMarkdownLinks(lease, note.path, references.links) || changed;
        changed = upsertNoteUrls(lease, note.path, references.urls) || changed;
      }
      db.prepare(
        "INSERT OR REPLACE INTO settings(key, value) VALUES('markdown_links_v1', '1')",
      ).run();
      if (changed) bumpGraphVersion();
    });
    tx();
  });
}

export function storeResolveAllLinks(
  lease: IndexLease,
  createWikilinkResolver: () => (content: string, fromPath: string) => string[],
): void {
  return withIndexMutation(lease, () => {
    const db = getDb();
    const notes = db
      .prepare('SELECT path, content, frontmatter FROM notes WHERE content IS NOT NULL')
      .all() as {
      path: string;
      content: string;
      frontmatter: string;
    }[];
    const resolve = createWikilinkResolver();
    let changed = false;
    for (const note of notes) {
      const links = resolve((note.frontmatter || '') + '\n' + note.content, note.path);
      changed = upsertLinks(lease, note.path, links) || changed;
    }
    // Startup migrations must not repeat a completed full-vault repair.
    if (changed) bumpGraphVersion();
    db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES('links_v1', '1')").run();
  });
}

export function storeResolveAllMarkdownReferences(
  lease: IndexLease,
  resolveMarkdownReferencesForNote: (
    fromPath: string,
    content: string,
    existingPaths: Set<string>,
  ) => { links: string[]; urls: string[] },
): void {
  return withIndexMutation(lease, () => {
    const db = getDb();
    const notes = db.prepare('SELECT path, content FROM notes WHERE content IS NOT NULL').all() as {
      path: string;
      content: string;
    }[];
    const existingPaths = new Set(notes.map((note) => note.path));
    let changed = false;
    for (const note of notes) {
      const references = resolveMarkdownReferencesForNote(note.path, note.content, existingPaths);
      changed = upsertMarkdownLinks(lease, note.path, references.links) || changed;
      changed = upsertNoteUrls(lease, note.path, references.urls) || changed;
    }
    if (changed) bumpGraphVersion();
    db.prepare(
      "INSERT OR REPLACE INTO settings(key, value) VALUES('markdown_links_v1', '1')",
    ).run();
  });
}

export function readWikiCatalogRows() {
  const db = getDb();
  // Load all paths, titles and aliases once — O(1) lookups instead of N queries
  return db.prepare('SELECT path, title, aliases FROM notes').all() as {
    path: string;
    title: string;
    aliases: string | null;
  }[];
}
