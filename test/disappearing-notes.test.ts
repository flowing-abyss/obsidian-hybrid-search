/**
 * Reproducer suite for the "disappearing notes" bug:
 * user adds new notes, unrelated notes temporarily vanish from search results.
 *
 * Four hypotheses are tested in isolation:
 *   H1 – Adding a new note invalidates cache → fresh DB query misses existing notes.
 *   H2 – Intermediate upsert state (chunks deleted, vectors gone) causes search misses.
 *   H3 – Tag-filtered search breaks when note's chunks are absent.
 *   H4 – Rapid sequential upserts (simulating concurrent batch indexing) leave orphaned state.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, it } from 'vitest';

// ─── Vault setup (must precede application module imports) ────────────────────

const vaultDir = mkdtempSync(path.join(tmpdir(), 'ohs-disappear-'));
process.env.OBSIDIAN_VAULT_PATH = vaultDir;

const { openDb, initVecTable, upsertNote, getDb } = await import('../src/db.js');
const { search, bumpIndexVersion } = await import('../src/searcher.js');

const DIM = 4;
// Distinct embeddings so semantic search can actually discriminate between notes.
let _seq = 0;
const emb = () => {
  const s = (_seq++ % 9) / 9;
  return new Float32Array([s, 1 - s, s * 0.5, (1 - s) * 0.5]);
};

function insertNote(p: string, title: string, content: string, tags: string[] = []) {
  upsertNote({
    path: p,
    title,
    tags,
    content,
    mtime: Date.now(),
    hash: 'h-' + p,
    chunks: [{ text: content, embedding: emb() }],
  });
}

beforeAll(() => {
  openDb();
  initVecTable(DIM);
});

afterAll(() => {
  rmSync(vaultDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// H1: Adding a new note invalidates the search cache.
//     The next search hits the DB fresh.  Existing notes must still be found.
// ─────────────────────────────────────────────────────────────────────────────

describe('H1 – cache invalidation: adding notes must not hide existing ones', () => {
  it('hybrid: note A survives after note B is added', async () => {
    insertNote('h1-a.md', 'Knowledge Base', 'knowledge base organisation');
    bumpIndexVersion();

    const before = await search('knowledge base', { mode: 'hybrid' });
    assert.ok(
      before.some((r) => r.path === 'h1-a.md'),
      'precondition: A must be found before B exists',
    );

    insertNote('h1-b.md', 'Programming Notes', 'javascript typescript node');
    bumpIndexVersion(); // simulates what upsertNote → bumpDbVersion does in production

    const after = await search('knowledge base', { mode: 'hybrid' });
    assert.ok(
      after.some((r) => r.path === 'h1-a.md'),
      'H1 FAILED: note A disappeared from hybrid search after note B was indexed',
    );
  });

  it('title: note A survives after note B is added', async () => {
    insertNote('h1-title-a.md', 'System Category Note', 'category management');
    bumpIndexVersion();

    const before = await search('System Category Note', { mode: 'title' });
    assert.ok(
      before.some((r) => r.path === 'h1-title-a.md'),
      'precondition: A must be found before B exists',
    );

    for (let i = 0; i < 10; i++) {
      insertNote(`h1-batch-${i}.md`, `Batch Note ${i}`, `batch content ${i}`);
    }
    bumpIndexVersion();

    const after = await search('System Category Note', { mode: 'title' });
    assert.ok(
      after.some((r) => r.path === 'h1-title-a.md'),
      'H1 FAILED: note A disappeared from title search after batch insert',
    );
  });

  it('tag-filtered: note A survives after unrelated note B is added', async () => {
    insertNote('h1-tagged-a.md', 'Tagged Knowledge', 'tagged knowledge content', [
      'system/category',
    ]);
    bumpIndexVersion();

    const before = await search('tagged knowledge', { tag: 'system/category' });
    assert.ok(
      before.some((r) => r.path === 'h1-tagged-a.md'),
      'precondition failed',
    );

    insertNote('h1-unrelated-b.md', 'Unrelated Note', 'completely different topic here');
    bumpIndexVersion();

    const after = await search('tagged knowledge', { tag: 'system/category' });
    assert.ok(
      after.some((r) => r.path === 'h1-tagged-a.md'),
      'H1 FAILED: tag-filtered note disappeared after unrelated note was added',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H2: Intermediate upsert state — note exists in `notes` (and FTS5) but its
//     chunks and vec_chunks have been deleted before new ones are inserted.
//     This is the window that exists because upsertNote is NOT transactional.
//     Hybrid search should still find the note via BM25.  Semantic cannot.
// ─────────────────────────────────────────────────────────────────────────────

describe('H2 – intermediate upsert state (no chunks / no vectors)', () => {
  it('hybrid finds note via BM25 even when vec_chunks are deleted', async () => {
    insertNote('h2-interim.md', 'Interim Note', 'unique interim indexing gap content');
    bumpIndexVersion();

    const before = await search('interim indexing gap', { mode: 'hybrid' });
    assert.ok(
      before.some((r) => r.path === 'h2-interim.md'),
      'precondition: found before deletion',
    );

    // Simulate the mid-upsert window: vectors gone, note still in notes/FTS5
    const db = getDb();
    const row = db.prepare('SELECT id FROM notes WHERE path = ?').get('h2-interim.md') as
      | { id: number }
      | undefined;
    assert.ok(row, 'note must exist in DB');

    db.prepare(
      'DELETE FROM vec_chunks WHERE chunk_id IN (SELECT id FROM chunks WHERE note_id = ?)',
    ).run(row.id);
    db.prepare('DELETE FROM chunks WHERE note_id = ?').run(row.id);
    bumpIndexVersion();

    const hybridResult = await search('interim indexing gap', { mode: 'hybrid' });
    assert.ok(
      hybridResult.some((r) => r.path === 'h2-interim.md'),
      'H2 FAILED: hybrid search lost note during intermediate upsert state (BM25 should still match)',
    );

    const semanticResult = await search('interim indexing gap', { mode: 'semantic' });
    assert.ok(
      !semanticResult.some((r) => r.path === 'h2-interim.md'),
      'sanity: semantic correctly misses note with no vectors',
    );
  });

  it('fulltext finds note even when vec_chunks are deleted', async () => {
    insertNote('h2-fts.md', 'FTS Stability', 'xyzmarker fts stability content');
    bumpIndexVersion();

    const db = getDb();
    const row = db.prepare('SELECT id FROM notes WHERE path = ?').get('h2-fts.md') as
      | { id: number }
      | undefined;
    assert.ok(row);

    db.prepare(
      'DELETE FROM vec_chunks WHERE chunk_id IN (SELECT id FROM chunks WHERE note_id = ?)',
    ).run(row.id);
    db.prepare('DELETE FROM chunks WHERE note_id = ?').run(row.id);
    bumpIndexVersion();

    const result = await search('xyzmarker fts stability', { mode: 'fulltext' });
    assert.ok(
      result.some((r) => r.path === 'h2-fts.md'),
      'H2 FAILED: fulltext lost note during intermediate upsert state',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H3: Tag filter + intermediate state.
//     If a note is in the intermediate state (no chunks) AND a tag filter is
//     applied, the tag-filtered SQL path might not return it.
// ─────────────────────────────────────────────────────────────────────────────

describe('H3 – tag-filtered search during intermediate upsert state', () => {
  it('tag filter still matches note when its chunks are absent', async () => {
    insertNote('h3-tagged.md', 'Tagged System Note', 'tagged system note unique phrase qqq', [
      'system/category',
    ]);
    bumpIndexVersion();

    const db = getDb();
    const row = db.prepare('SELECT id FROM notes WHERE path = ?').get('h3-tagged.md') as
      | { id: number }
      | undefined;
    assert.ok(row);

    db.prepare(
      'DELETE FROM vec_chunks WHERE chunk_id IN (SELECT id FROM chunks WHERE note_id = ?)',
    ).run(row.id);
    db.prepare('DELETE FROM chunks WHERE note_id = ?').run(row.id);
    bumpIndexVersion();

    const result = await search('tagged system note unique phrase qqq', { tag: 'system/category' });
    assert.ok(
      result.some((r) => r.path === 'h3-tagged.md'),
      'H3 FAILED: tag-filtered search lost note during intermediate upsert state',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H4: Sequential re-upsert of the same note.
//     Simulates what happens during background indexing when many notes are
//     processed: a note is upserted, then upserted again (e.g., re-index on
//     server restart).  The final state must be consistent.
// ─────────────────────────────────────────────────────────────────────────────

describe('H4 – re-upsert (re-index) of same note stays consistent', () => {
  it('note is findable after being upserted twice in a row', async () => {
    insertNote('h4-reingest.md', 'Re-Index Target', 'reingest unique word abcdef');
    bumpIndexVersion();

    // Re-upsert (simulates background re-index finding mtime/hash changed)
    insertNote('h4-reingest.md', 'Re-Index Target', 'reingest unique word abcdef updated');
    bumpIndexVersion();

    const result = await search('reingest unique word abcdef', { mode: 'hybrid' });
    assert.ok(
      result.some((r) => r.path === 'h4-reingest.md'),
      'H4 FAILED: note disappeared after being upserted twice',
    );
  });

  it('all notes remain findable after rapid sequential upserts of many notes', async () => {
    const paths = Array.from({ length: 20 }, (_, i) => `h4-rapid-${i}.md`);

    // First pass
    for (const p of paths) {
      insertNote(p, `Rapid ${p}`, `rapid sequential content for ${p} marker`);
    }
    bumpIndexVersion();

    // Second pass (re-index all)
    for (const p of paths) {
      insertNote(p, `Rapid ${p}`, `rapid sequential content for ${p} marker v2`);
    }
    bumpIndexVersion();

    const missing: string[] = [];
    for (const p of paths) {
      const results = await search(`rapid sequential content for ${p} marker`, {
        mode: 'fulltext',
      });
      if (!results.some((r) => r.path === p)) missing.push(p);
    }

    assert.deepEqual(
      missing,
      [],
      `H4 FAILED: notes disappeared after rapid sequential re-upserts: ${missing.join(', ')}`,
    );
  });
});
