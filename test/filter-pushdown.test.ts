import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, it, vi } from 'vitest';

// ─── Vault setup (before any import that reads OBSIDIAN_VAULT_PATH) ──────────

const vaultDir = mkdtempSync(path.join(tmpdir(), 'ohs-pushdown-test-'));
process.env.OBSIDIAN_VAULT_PATH = vaultDir;

// Embedding always fails, so the vector arm contributes nothing and every assertion
// below is about the FTS arms alone. That is exactly the scope of this test file.
vi.mock('../src/embedder.js', () => ({
  embed: vi.fn((texts: string[]) => Promise.resolve(texts.map(() => null))),
}));

const { closeDb } = await import('../src/db.js');
const { search } = await import('../src/searcher.js');
const { seedPushdownVault, NEEDLE_PATHS } = await import('./fixtures/pushdown-vault.js');

beforeAll(() => {
  seedPushdownVault();
});

afterAll(() => {
  closeDb();
  rmSync(vaultDir, { recursive: true, force: true });
});

describe('filter pushdown', () => {
  // Runs FIRST on purpose. Every pushdown assertion below is only meaningful while the
  // needle notes are unreachable without a filter; if this breaks, they all still pass
  // and prove nothing.
  it('fixture invariant: needle notes are outside the unfiltered top-5', async () => {
    for (const mode of ['fulltext', 'title'] as const) {
      const top = await search('alpha', { mode, limit: 5 });
      assert.equal(top.length, 5, `${mode}: fixture did not produce a full top-5`);
      assert.ok(
        top.every((r) => !NEEDLE_PATHS.includes(r.path)),
        `${mode}: a needle note reached the unfiltered top-5 — every pushdown test below is now vacuous`,
      );
    }
  });

  it.each([['fulltext'], ['title']] as const)(
    '%s returns a needle note that cannot reach the unfiltered top-5',
    async (mode) => {
      const results = await search('alpha', { mode, tag: 'needle', limit: 5 });
      assert.ok(results.some((r) => NEEDLE_PATHS.includes(r.path)));
    },
  );

  it('frontmatter narrows the pool for a text query', async () => {
    const results = await search('alpha', { frontmatter: 'status:rare', limit: 5 });
    assert.ok(results.some((r) => NEEDLE_PATHS.includes(r.path)));
  });

  it('scope narrows the pool for a text query', async () => {
    const results = await search('alpha', { scope: 'deep', limit: 5 });
    assert.ok(results.length > 0);
    assert.ok(results.every((r) => r.path.startsWith('deep/')));
  });

  // Characterization: pre-existing and deliberate. Tag matching is by SUBSTRING, so a
  // filter of "meta" also matches "metadata". Changing this is a separate decision with
  // its own effect on results — see the 2026-08-08 filter-pushdown spec.
  it('tag filter matches by substring: "meta" also matches "metadata"', async () => {
    const paths = (await search('alpha', { tag: 'meta', limit: 20 })).map((r) => r.path);
    assert.ok(paths.includes('tagged-meta.md'.normalize('NFD')));
    assert.ok(paths.includes('tagged-metadata.md'.normalize('NFD')));
  });
});
