import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { checkArchitecture } from './architecture/check.js';

const roots: string[] = [];
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(process.cwd(), '.architecture-fixture-'));
  roots.push(root);
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: {} }));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), text);
  }
  return root;
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const db =
  'export function getDb() { return { prepare(sql: string) { return sql; } }; } export const safe = 1;';

it.each([
  ['named alias', "import { getDb as acquire } from '../storage/db.js'; acquire();"],
  ['namespace', "import * as storage from '../storage/db.js'; storage.getDb();"],
  ['re-export', "export { getDb as acquire } from '../storage/db.js';"],
  ['star re-export', "export * from '../storage/db.js';"],
  ['dynamic', "const {getDb: acquire} = await import('../storage/db.js'); acquire();"],
])('rejects raw storage acquisition: %s', async (_, source) => {
  const violations = await checkArchitecture(
    fixture({ 'src/storage/db.ts': db, 'src/search/searcher.ts': source }),
  );
  expect(violations.some((v) => v.includes('raw-storage-access'))).toBe(true);
});
it('rejects raw handles through an intermediate re-export', async () => {
  const violations = await checkArchitecture(
    fixture({
      'src/storage/db.ts': db,
      'src/storage/leak.ts': "export {getDb as acquire} from './db.js';",
      'src/search/searcher.ts': "import {acquire} from '../storage/leak.js'; acquire();",
    }),
  );
  expect(violations.some((v) => v.includes('raw-storage-access'))).toBe(true);
});
it('rejects consuming the raw connection returned from initialization', async () => {
  const violations = await checkArchitecture(
    fixture({
      'src/storage/db.ts': db + ' export const openDb = getDb;',
      'src/search/searcher.ts':
        "import {openDb as initialize} from '../storage/db.js'; const connection = initialize(); connection.prepare('SELECT 1');",
    }),
  );
  expect(violations.some((v) => v.includes('raw-storage-access'))).toBe(true);
});
it.each([
  [
    'pure-extraction',
    'src/content/note-extractor.ts',
    "import '../runtime/config.js';",
    'src/runtime/config.ts',
  ],
  [
    'storage-no-orchestration',
    'src/storage/notes.ts',
    "export {safe} from '../indexing/indexer.js';",
    'src/indexing/indexer.ts',
  ],
  [
    'sqlite-acquisition',
    'src/search/searcher.ts',
    "import '../../node_modules/better-sqlite3/index.js';",
    'node_modules/better-sqlite3/index.ts',
  ],
  [
    'infrastructure-no-transports',
    'src/indexing/chunk-embedding.ts',
    "void import('../transports/stdio-server.js');",
    'src/transports/stdio-server.ts',
  ],
  [
    'indexer-independent',
    'src/indexing/indexer.ts',
    "import '../search/searcher.js';",
    'src/search/searcher.ts',
  ],
  [
    'pure-normalization',
    'src/content/text-normalization.ts',
    "export {safe} from '../storage/db.js';",
    'src/storage/db.ts',
  ],
  [
    'infrastructure-no-transports',
    'src/storage/notes.ts',
    "import type {Value} from '../transports/cli.js';",
    'src/transports/cli.ts',
  ],
  [
    'infrastructure-no-transports',
    'src/inference/embedder.ts',
    "void import('../transports/mcp-runtime.js');",
    'src/transports/mcp-runtime.ts',
  ],
])('rejects dependency rule %s', async (rule, file, source, target) => {
  const violations = await checkArchitecture(
    fixture({ [file]: source, [target]: 'export type Value = string; export const safe = 1;' }),
  );
  expect(violations.some((v) => v.includes(rule))).toBe(true);
});
it('rejects cycles and unlisted packages', async () => {
  const root = fixture({
    'src/content/a.ts': "import './b.js'; import 'unlisted';",
    'src/content/b.ts': "import './a.js';",
    'node_modules/unlisted/package.json': '{"name":"unlisted","main":"index.js"}',
    'node_modules/unlisted/index.js': 'module.exports = 1;',
  });
  const violations = await checkArchitecture(root);
  expect(violations.some((v) => v.includes('no-circular'))).toBe(true);
  expect(violations.some((v) => v.includes('no-unlisted-dependencies'))).toBe(true);
});
it('accepts typed storage operations and unrelated prepare/exec methods', async () => {
  const root = fixture({
    'src/storage/db.ts': db,
    'src/storage/notes.ts':
      "import {getDb} from './db.js'; export const rows = () => getDb().prepare('SELECT 1');",
    'src/search/searcher.ts':
      "import {safe} from '../storage/db.js'; import type {Value} from '../contracts/value.js'; const helper = {prepare() {}, exec() {}}; helper.prepare(); helper.exec(); void import('../storage/notes.js'); export {safe};",
    'src/contracts/value.ts': 'export type Value = string;',
    'src/content/new-format.ts':
      "import {normalize} from './text-normalization.js'; export const parse = normalize;",
    'src/transports/cli.ts': "import '../search/searcher.js';",
    'src/cli.ts': "import './transports/cli.js';",
    'src/server.ts': "import './transports/cli.js';",
    'src/content/text-normalization.ts':
      'export const normalize = (v: string) => v.normalize("NFD");',
  });
  expect(await checkArchitecture(root)).toEqual([]);
});
it('enforces boundaries on production sources', async () => {
  expect(await checkArchitecture(process.cwd())).toEqual([]);
}, 30_000);

it.each([
  [
    'inference-no-application',
    'src/inference/new-feature.ts',
    "import '../storage/db.js';",
    'src/storage/db.ts',
  ],
  [
    'search-no-indexing',
    'src/search/new-feature.ts',
    "import '../indexing/new-feature.js';",
    'src/indexing/new-feature.ts',
  ],
  [
    'indexer-independent',
    'src/indexing/new-feature.ts',
    "import '../search/new-feature.js';",
    'src/search/new-feature.ts',
  ],
  [
    'content-no-application',
    'src/content/new-format.ts',
    "import '../inference/embedder.js';",
    'src/inference/embedder.ts',
  ],
  [
    'runtime-independent',
    'src/runtime/new-helper.ts',
    "import '../search/searcher.js';",
    'src/search/searcher.ts',
  ],
  [
    'contracts-independent',
    'src/contracts/new-options.ts',
    "import '../storage/db.js';",
    'src/storage/db.ts',
  ],
  [
    'vault-no-application',
    'src/vault/new-discovery.ts',
    "import '../indexing/indexer.js';",
    'src/indexing/indexer.ts',
  ],
])('enforces directory ownership for new files: %s', async (rule, file, source, target) => {
  const violations = await checkArchitecture(
    fixture({ [file]: source, [target]: 'export const safe = 1;' }),
  );
  expect(violations.some((v) => v.includes(rule))).toBe(true);
});
it.each(['src/loose-helper.ts', 'src/misc/helper.ts'])(
  'requires an architectural owner for %s',
  async (file) => {
    expect(await checkArchitecture(fixture({ [file]: 'export const value = 1;' }))).toContain(
      `source-layout: ${file}`,
    );
  },
);
