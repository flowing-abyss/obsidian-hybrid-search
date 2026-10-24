import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, it, vi } from 'vitest';

const vaultDir = mkdtempSync(path.join(tmpdir(), 'ohs-link-migrations-'));
process.env.OBSIDIAN_VAULT_PATH = vaultDir;

const { closeDb, getDb, initVecTable, openDb } = await import('./helpers/owned-storage.js');
const embedder = await import('../src/inference/embedder.js');
const { indexFile, indexVaultSync, resetIndexingState } =
  await import('./helpers/owned-indexer.js');
const { runHttpMcpServer } = await import('../src/transports/mcp-http-server.js');

beforeEach(() => {
  closeDb();
  for (const name of readdirSync(vaultDir)) {
    rmSync(path.join(vaultDir, name), { recursive: true });
  }
  vi.stubEnv('OBSIDIAN_VAULT_PATH', vaultDir);
  for (const key of [
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_EMBEDDING_MODEL',
    'LOCAL_EMBEDDING_MODEL',
    'OBSIDIAN_IGNORE_PATTERNS',
    'OBSIDIAN_INCLUDE_PATTERNS',
  ]) {
    vi.stubEnv(key, undefined);
  }
  vi.spyOn(embedder, 'embedDetailed').mockImplementation((texts: string[]) =>
    Promise.resolve(
      texts.map(() => ({
        ok: true as const,
        embedding: new Float32Array([0.1, 0.2, 0.3, 0.4]),
      })),
    ),
  );
  vi.spyOn(embedder, 'getContextLength').mockResolvedValue(512);
  vi.spyOn(embedder, 'getDocumentTokenPolicy').mockResolvedValue({
    limit: 508,
    count: (text) => Math.ceil(Array.from(text).length / 4),
  });
  openDb();
  initVecTable(4);
  resetIndexingState();
});

afterEach(() => {
  closeDb();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

afterAll(() => {
  rmSync(vaultDir, { recursive: true, force: true });
});

function writeLinkedNotes(): void {
  writeFileSync(
    path.join(vaultDir, 'a-source.md'),
    '# Source\n\nSee [[z-target]] and [Target](z-target.md).\n' +
      'Read https://second.example then https://first.example.\n',
  );
  writeFileSync(path.join(vaultDir, 'z-target.md'), '# Target\n\nThe target note.\n');
}

function assertReferences(): void {
  const db = getDb();
  for (const table of ['links', 'markdown_links']) {
    assert.deepEqual(
      db.prepare(`SELECT from_path, to_path FROM ${table} ORDER BY from_path, to_path`).all(),
      [{ from_path: 'a-source.md', to_path: 'z-target.md' }],
    );
  }
  assert.deepEqual(
    db
      .prepare('SELECT url FROM note_urls WHERE from_path = ? ORDER BY position')
      .all('a-source.md'),
    [{ url: 'https://second.example' }, { url: 'https://first.example' }],
  );
}

function marker(key: string): string | undefined {
  return (
    getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      { value: string } | undefined
  )?.value;
}

describe('link migration completion after full vault reindex', () => {
  it.each([false, true])(
    'starts HTTP without repeating completed link repairs with force=%s',
    async (force) => {
      writeLinkedNotes();
      const result = await indexVaultSync(force);
      assert.deepEqual(result, { indexed: 2, skipped: 0, errors: [] });
      assertReferences();

      // Persist the guards across the server's database reopen. Startup must use
      // the completed index without deleting and recreating its references.
      for (const table of ['links', 'markdown_links', 'note_urls']) {
        getDb().exec(`
        CREATE TRIGGER reject_startup_${table} BEFORE DELETE ON ${table}
        BEGIN SELECT RAISE(ABORT, 'startup repeated ${table} repair'); END;
      `);
      }
      closeDb();

      const server = await runHttpMcpServer({ host: '127.0.0.1', port: 0 });
      try {
        const res = await fetch(server.healthUrl);
        assert.equal(res.status, 200);
        assert.equal(((await res.json()) as { ok: boolean }).ok, true);
        assertReferences();
      } finally {
        await server.close();
      }
    },
  );

  it.each([false, true])(
    'records completed link repairs for an empty vault with force=%s',
    async (force) => {
      assert.deepEqual(await indexVaultSync(force), { indexed: 0, skipped: 0, errors: [] });
      closeDb();
      openDb();
      assert.equal(marker('links_v1'), '1');
      assert.equal(marker('markdown_links_v1'), '1');
    },
  );

  it.each([
    { table: 'links', key: 'links_v1' },
    { table: 'markdown_links', key: 'markdown_links_v1' },
  ])('keeps a failed $table repair retryable', async ({ table, key }) => {
    writeLinkedNotes();
    for (const name of ['a-source.md', 'z-target.md']) {
      assert.equal(await indexFile(path.join(vaultDir, name), 512), 'indexed');
    }
    assert.equal(await indexFile(path.join(vaultDir, 'a-source.md'), 512, true), 'indexed');
    assertReferences();
    // A no-op repair no longer rewrites references. Corrupt an actual edge so
    // this guard exercises rollback of a required repair rather than a no-op.
    getDb()
      .prepare(`UPDATE ${table} SET to_path = 'obsolete.md' WHERE from_path = 'a-source.md'`)
      .run();
    getDb().exec(`
      CREATE TRIGGER fail_repair BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT, 'link repair failed'); END;
    `);

    await assert.rejects(() => indexVaultSync(), /link repair failed/);
    assert.equal(marker(key), undefined);

    getDb().exec('DROP TRIGGER fail_repair');
    const result = await indexVaultSync();
    assert.deepEqual(result, { indexed: 0, skipped: 2, errors: [] });
    assert.equal(marker(key), '1');
    assertReferences();
  });
});
