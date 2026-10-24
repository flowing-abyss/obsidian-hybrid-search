import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeEach, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vault = mkdtempSync(path.join(tmpdir(), 'ohs-repair-cache-'));
process.env.OBSIDIAN_VAULT_PATH = vault;
const db = await import('./helpers/owned-storage.js');
const { search } = await import('../src/search/searcher.js');
const { bumpIndexVersion } = await import('../src/storage/index-state.js');

beforeEach(() => {
  db.closeDb();
  rmSync(vault, { recursive: true, force: true });
  mkdirSync(vault, { recursive: true });
  db.openDb();
  db.initVecTable(4);
  bumpIndexVersion();
  for (const name of ['a.md', 'b.md'])
    db.upsertNote({
      path: name,
      title: name,
      tags: ['seed'],
      content: 'Body',
      mtime: 1,
      hash: name,
      chunks: [],
    });
});
afterAll(() => {
  db.closeDb();
  rmSync(vault, { recursive: true, force: true });
});

function repairInAnotherProcess(operation: string): [number, number, number] {
  const output = execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
    const db = await import(${JSON.stringify(pathToFileURL(path.join(root, 'src/storage/db.ts')).href)});
    const queries = await import(${JSON.stringify(pathToFileURL(path.join(root, 'src/storage/index-queries.ts')).href)});
    db.openDb();
    const lease = db.claimIndexLease('repair-cache', 'background');
    if (!lease) throw new Error('No repair owner');
    const repair = () => { ${operation} };
    const versions = [db.getDbVersion()];
    repair(); versions.push(db.getDbVersion());
    repair(); versions.push(db.getDbVersion());
    db.releaseIndexLease(lease); db.closeDb();
    console.log(JSON.stringify(versions));
  `,
    ],
    {
      cwd: root,
      env: { ...process.env, OBSIDIAN_VAULT_PATH: vault },
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  return JSON.parse(output.trim()) as [number, number, number];
}

it.each(['populate-wiki', 'resolve-wiki', 'populate-markdown', 'resolve-markdown'])(
  '%s invalidates another reader once and leaves no-op repairs unchanged',
  async (mode) => {
    const options = { related: true, direction: 'outgoing' as const };
    assert.deepEqual(
      (await search('a.md', options)).map((note) => note.path),
      ['a.md'],
    );
    const resolve = "(_content, fromPath) => fromPath === 'a.md' ? ['b.md'] : []";
    const markdown =
      "(fromPath) => fromPath === 'a.md' ? { links: ['b.md'], urls: ['https://example.com'] } : { links: [], urls: [] }";
    const operation =
      mode === 'populate-wiki'
        ? `queries.storePopulateMissingLinks(lease, ${resolve});`
        : mode === 'resolve-wiki'
          ? `queries.storeResolveAllLinks(lease, () => ${resolve});`
          : mode === 'populate-markdown'
            ? `queries.storePopulateMissingMarkdownReferences(lease, ${markdown});`
            : `queries.storeResolveAllMarkdownReferences(lease, ${markdown});`;
    const [before, repaired, unchanged] = repairInAnotherProcess(operation);
    assert.equal(repaired, before + 1);
    assert.equal(unchanged, repaired);
    const results = await search('a.md', options);
    if (mode.endsWith('markdown')) {
      assert.deepEqual(results.find((note) => note.path === 'a.md')?.urls, ['https://example.com']);
      assert.deepEqual(results.find((note) => note.path === 'a.md')?.markdownLinks, ['b.md']);
    } else
      assert.deepEqual(
        results.map((note) => note.path).sort((a, b) => a.localeCompare(b)),
        ['a.md', 'b.md'],
      );
  },
);

it('invalidates readers when legacy NFC rows are removed and leaves a clean pass unchanged', async () => {
  db.getDb().prepare('UPDATE notes SET path=? WHERE path=?').run('Café.md', 'b.md');
  assert.equal((await search('', { tag: 'seed' })).length, 2);
  const [before, repaired, unchanged] = repairInAnotherProcess('db.cleanupLegacyPaths(lease);');
  assert.equal(repaired, before + 1);
  assert.equal(unchanged, repaired);
  assert.deepEqual(
    (await search('', { tag: 'seed' })).map((note) => note.path),
    ['a.md'],
  );
});
