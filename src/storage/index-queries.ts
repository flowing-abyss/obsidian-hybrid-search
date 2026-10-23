import { getDb, upsertLinks, upsertMarkdownLinks, upsertNoteUrls } from './db.js';

export function getExistingNotePathSet(): Set<string> {
  const rows = getDb().prepare('SELECT path FROM notes').all() as { path: string }[];
  return new Set(rows.map((row) => row.path));
}

export function updateNoteMtime(mtime: number, relPath: string): void {
  getDb().prepare('UPDATE notes SET mtime = ? WHERE path = ?').run(mtime, relPath);
}

export function storePopulateMissingLinks(
  resolveWikilinks: (content: string, fromPath: string) => string[],
): void {
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
  for (const note of notes) {
    const links = resolveWikilinks((note.frontmatter || '') + '\n' + note.content, note.path);
    upsertLinks(note.path, links);
  }

  db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES('links_v1', '1')").run();
}

export function storePopulateMissingMarkdownReferences(
  resolveMarkdownReferencesForNote: (
    fromPath: string,
    content: string,
    existingPaths: Set<string>,
  ) => { links: string[]; urls: string[] },
): void {
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
    for (const note of notes) {
      const references = resolveMarkdownReferencesForNote(note.path, note.content, existingPaths);
      upsertMarkdownLinks(note.path, references.links);
      upsertNoteUrls(note.path, references.urls);
    }
    db.prepare(
      "INSERT OR REPLACE INTO settings(key, value) VALUES('markdown_links_v1', '1')",
    ).run();
    db.prepare(
      "INSERT OR REPLACE INTO settings(key, value) VALUES('db_version', CAST(COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'db_version'), 0) + 1 AS TEXT))",
    ).run();
  });
  tx();
}

export function storeResolveAllLinks(
  createWikilinkResolver: () => (content: string, fromPath: string) => string[],
): void {
  const db = getDb();
  const notes = db
    .prepare('SELECT path, content, frontmatter FROM notes WHERE content IS NOT NULL')
    .all() as {
    path: string;
    content: string;
    frontmatter: string;
  }[];
  const resolve = createWikilinkResolver();
  for (const note of notes) {
    const links = resolve((note.frontmatter || '') + '\n' + note.content, note.path);
    upsertLinks(note.path, links);
  }
  // Startup migrations must not repeat a completed full-vault repair.
  db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES('links_v1', '1')").run();
}

export function storeResolveAllMarkdownReferences(
  resolveMarkdownReferencesForNote: (
    fromPath: string,
    content: string,
    existingPaths: Set<string>,
  ) => { links: string[]; urls: string[] },
): void {
  const db = getDb();
  const notes = db.prepare('SELECT path, content FROM notes WHERE content IS NOT NULL').all() as {
    path: string;
    content: string;
  }[];
  const existingPaths = new Set(notes.map((note) => note.path));
  for (const note of notes) {
    const references = resolveMarkdownReferencesForNote(note.path, note.content, existingPaths);
    upsertMarkdownLinks(note.path, references.links);
    upsertNoteUrls(note.path, references.urls);
  }
  db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES('markdown_links_v1', '1')").run();
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
