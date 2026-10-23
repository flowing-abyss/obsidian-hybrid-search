// Bounded, reproducible properties. fast-check reports seed/path for every failure;
// set FC_SEED and FC_PATH to replay a shrunk case with the focused test name.
import fc from 'fast-check';
import { mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';

const vault = mkdtempSync(path.join(tmpdir(), 'ohs-properties-'));
process.env.OBSIDIAN_VAULT_PATH = vault;
const db = await import('../src/db.js');
const embedder = await import('../src/embedder.js');
function vector(text: string): Float32Array {
  const sum = Array.from(text).reduce((n, c) => n + c.codePointAt(0)!, 0);
  return new Float32Array([1, (sum % 101) / 101, (text.length % 97) / 97, 0.5]);
}
vi.spyOn(embedder, 'embedDetailed').mockImplementation((texts) =>
  Promise.resolve(texts.map((text) => ({ ok: true as const, embedding: vector(text) }))),
);
vi.spyOn(embedder, 'embed').mockImplementation((texts) => Promise.resolve(texts.map(vector)));
vi.spyOn(embedder, 'getContextLength').mockResolvedValue(64);
vi.spyOn(embedder, 'getDocumentTokenPolicy').mockResolvedValue({
  limit: 60,
  count: (text) => Array.from(text).length,
});
const { chunkNote, refineChunksToFit } = await import('../src/chunker.js');
const { buildFilterPredicate } = await import('../src/filter-predicate.js');
const { indexFile, indexVaultSync, cleanupStaleNotes } = await import('../src/indexer.js');
const { search } = await import('../src/searcher.js');
const { bumpIndexVersion } = await import('../src/index-state.js');

const parameters = {
  seed: Number(process.env.FC_SEED ?? 20261023),
  ...(process.env.FC_PATH ? { path: process.env.FC_PATH } : {}),
};
function resetDb(): void {
  db.wipeDatabaseFiles();
  db.openDb();
  db.initVecTable(4);
  bumpIndexVersion();
}
afterAll(() => {
  vi.restoreAllMocks();
  db.closeDb();
  rmSync(vault, { recursive: true, force: true });
});
const unicodeWord = fc
  .array(fc.constantFrom('é', 'e\u0301', '界', '😀', 'Ж', 'a', 'ß', '🏳️‍🌈'), {
    minLength: 1,
    maxLength: 12,
  })
  .map((letters) => letters.join(''));

it('Unicode chunks recover source slices and refinement preserves complete input coverage', () => {
  fc.assert(
    fc.property(
      fc.array(unicodeWord, { minLength: 8, maxLength: 50 }),
      fc.integer({ min: 12, max: 60 }),
      (words, budget) => {
        const source = `# é😀\n\n${words.join(' ')}\n\n## e\u0301\n${words.slice().reverse().join('\n')}`;
        // Initial semantic chunking intentionally omits short/markup-only fragments.
        // Test its origins separately; a complete source input independently proves
        // refinement coverage without copying the chunker's selection policy.
        const selected = chunkNote(source, budget);
        const chunks = refineChunksToFit(
          source,
          [{ text: source, charStart: 0, charEnd: source.length, headingChain: [] }],
          budget,
          (text) => Array.from(text).length,
          0,
        );
        expect(chunks.length).toBeGreaterThan(0);
        for (const chunk of [...selected, ...chunks]) {
          expect(source.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.text);
          expect(chunk.charStart).toBeGreaterThanOrEqual(0);
          expect(chunk.charEnd).toBeLessThanOrEqual(source.length);
          // No boundary may bisect a UTF-16 surrogate pair.
          for (const offset of [chunk.charStart, chunk.charEnd]) {
            expect(
              offset > 0 &&
                /[\uD800-\uDBFF]/.test(source[offset - 1]!) &&
                /[\uDC00-\uDFFF]/.test(source[offset] ?? ''),
            ).toBe(false);
          }
        }
        for (let offset = 0; offset < source.length; offset++) {
          if (!/\s/.test(source[offset]!))
            expect(chunks.some((c) => c.charStart <= offset && offset < c.charEnd)).toBe(true);
        }
      },
    ),
    { ...parameters, numRuns: 40 },
  );
});

const tag = fc.constantFrom('alpha', 'beta', 'café', 'équipe', 'meta/data');
const scope = fc.constantFrom('notes', 'notes/deep', 'archive', 'café');
const filter = (values: fc.Arbitrary<string>) =>
  fc.array(
    fc.tuple(fc.boolean(), values).map(([exclude, value]) => (exclude ? '-' : '') + value),
    { maxLength: 4 },
  );

it('SQLite filter predicates obey independent AND/OR/exclusion set semantics', () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          tags: fc.uniqueArray(tag, { maxLength: 4 }),
          folder: scope,
          state: fc.constantFrom('open', 'closed'),
        }),
        { minLength: 1, maxLength: 10 },
      ),
      filter(tag),
      filter(scope),
      filter(fc.constantFrom('state:open', 'state:closed')),
      (notes, tags, scopes, fields) => {
        resetDb();
        const rows = notes.map((note, i) => ({
          ...note,
          path: `${note.folder}/${i}.md`.normalize('NFD'),
        }));
        for (const note of rows)
          db.upsertNote({
            path: note.path,
            title: note.path,
            tags: note.tags,
            frontmatter: { state: note.state },
            content: 'alpha',
            mtime: 1,
            hash: note.path,
            chunks: [{ text: 'alpha', embedding: vector('alpha') }],
          });
        const predicate = buildFilterPredicate({ tag: tags, scope: scopes, frontmatter: fields });
        const actual = db
          .getDb()
          .prepare(
            'SELECT n.path FROM notes n' +
              (predicate.isEmpty ? '' : ' WHERE ' + predicate.sql) +
              ' ORDER BY n.path',
          )
          .all(...predicate.params) as { path: string }[];
        const includes = (values: string[]) => values.filter((v) => !v.startsWith('-'));
        const excludes = (values: string[]) =>
          values.filter((v) => v.startsWith('-')).map((v) => v.slice(1));
        const expected = rows
          .filter((note) => {
            const hasTag = (v: string) =>
              note.tags.some((t) =>
                t.normalize('NFD').toLowerCase().includes(v.normalize('NFD').toLowerCase()),
              );
            const inScope = (v: string) =>
              note.path === v.normalize('NFD') || note.path.startsWith(v.normalize('NFD') + '/');
            const hasField = (v: string) => v === `state:${note.state}`;
            return (
              includes(tags).every(hasTag) &&
              !excludes(tags).some(hasTag) &&
              (includes(scopes).length === 0 || includes(scopes).some(inScope)) &&
              !excludes(scopes).some(inScope) &&
              includes(fields).every(hasField) &&
              !excludes(fields).some(hasField)
            );
          })
          .map((n) => n.path)
          .sort((a, b) => a.localeCompare(b));
        expect(actual.map((n) => n.path)).toEqual(expected);
      },
    ),
    { ...parameters, numRuns: 35 },
  );
});

function snapshot() {
  const connection = db.getDb();
  return {
    notes: connection
      .prepare(
        'SELECT path, title, tags, aliases, content, frontmatter, hash FROM notes ORDER BY path',
      )
      .all(),
    chunks: connection
      .prepare(
        'SELECT n.path, c.chunk_index, c.text, c.heading_path, c.char_start, c.char_end, c.embedding_status, hex(v.embedding) AS embedding FROM chunks c JOIN notes n ON n.id=c.note_id JOIN vec_chunks v ON v.chunk_id=c.id ORDER BY n.path, c.chunk_index',
      )
      .all(),
    links: connection.prepare('SELECT * FROM links ORDER BY from_path, to_path').all(),
    markdown: connection.prepare('SELECT * FROM markdown_links ORDER BY from_path, to_path').all(),
    urls: connection.prepare('SELECT * FROM note_urls ORDER BY from_path, url').all(),
  };
}
async function searchSnapshot() {
  const fulltext = await search('alpha', { mode: 'fulltext', limit: 100, anchors: true });
  const semantic = await search('alpha', { mode: 'semantic', limit: 100 });
  // Equal-score row IDs may differ after rebuilding; compare each note's contract.
  return [fulltext, semantic].map((results) =>
    results
      .map(({ rank: _rank, ...result }) => ({
        ...result,
        links: [...result.links].sort((a, b) => a.localeCompare(b)),
        backlinks: [...result.backlinks].sort((a, b) => a.localeCompare(b)),
        markdownLinks: [...result.markdownLinks].sort((a, b) => a.localeCompare(b)),
        markdownBacklinks: [...result.markdownBacklinks].sort((a, b) => a.localeCompare(b)),
        urls: [...result.urls].sort((a, b) => a.localeCompare(b)),
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  );
}
it('incremental edits, renames and deletes equal a fresh index of final files', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc.record({
          slot: fc.integer({ min: 0, max: 3 }),
          kind: fc.constantFrom('write', 'delete', 'rename'),
          text: unicodeWord,
        }),
        { minLength: 4, maxLength: 10 },
      ),
      async (operations) => {
        for (const name of readdirSync(vault))
          if (name.endsWith('.md')) rmSync(path.join(vault, name));
        resetDb();
        const body = (value: string) =>
          `---\ntitle: alpha ${value}\ntags: [alpha, café]\naliases: [identity]\nstate: open\n---\n# alpha\n${value}\n[[anchor]] [anchor](anchor.md) https://example.com/alpha\n`;
        writeFileSync(path.join(vault, 'anchor.md'), '# anchor\nalpha anchor');
        await indexFile(path.join(vault, 'anchor.md'), 64, true);
        for (const operation of operations) {
          const file = path.join(vault, `note-${operation.slot}.md`);
          if (operation.kind === 'write') {
            writeFileSync(file, body(operation.text));
            expect(await indexFile(file, 64, true)).toBe('indexed');
          } else if (operation.kind === 'delete') rmSync(file, { force: true });
          else if (readdirSync(vault).includes(path.basename(file)))
            renameSync(file, path.join(vault, `renamed-${operation.slot}.md`));
          const paths = new Set(
            readdirSync(vault)
              .filter((name) => name.endsWith('.md'))
              .map((name) => name.normalize('NFD')),
          );
          cleanupStaleNotes(paths);
        }
        expect((await indexVaultSync(false)).errors).toEqual([]);
        const incremental = snapshot();
        const incrementalSearch = await searchSnapshot();
        resetDb();
        expect((await indexVaultSync(true)).errors).toEqual([]);
        expect(snapshot()).toEqual(incremental);
        expect(await searchSnapshot()).toEqual(incrementalSearch);
      },
    ),
    { ...parameters, numRuns: 12 },
  );
});
