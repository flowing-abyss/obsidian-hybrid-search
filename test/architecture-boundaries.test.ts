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
  ['named alias', "import { getDb as acquire } from './db.js'; acquire();"],
  ['namespace', "import * as storage from './db.js'; storage.getDb();"],
  ['re-export', "export { getDb as acquire } from './db.js';"],
  ['star re-export', "export * from './db.js';"],
  ['dynamic', "const {getDb: acquire} = await import('./db.js'); acquire();"],
])('rejects raw storage acquisition: %s', async (_, source) => {
  const violations = await checkArchitecture(
    fixture({ 'src/db.ts': db, 'src/searcher.ts': source }),
  );
  expect(violations.some((v) => v.includes('raw-storage-access'))).toBe(true);
});
it('rejects raw handles through an intermediate re-export', async () => {
  const violations = await checkArchitecture(
    fixture({
      'src/db.ts': db,
      'src/storage/leak.ts': "export {getDb as acquire} from '../db.js';",
      'src/searcher.ts': "import {acquire} from './storage/leak.js'; acquire();",
    }),
  );
  expect(violations.some((v) => v.includes('raw-storage-access'))).toBe(true);
});
it('rejects consuming the raw connection returned from initialization', async () => {
  const violations = await checkArchitecture(
    fixture({
      'src/db.ts': db + ' export const openDb = getDb;',
      'src/searcher.ts':
        "import {openDb as initialize} from './db.js'; const connection = initialize(); connection.prepare('SELECT 1');",
    }),
  );
  expect(violations.some((v) => v.includes('raw-storage-access'))).toBe(true);
});
it.each([
  ['pure-extraction', 'src/note-extractor.ts', "import './config.js';", 'src/config.ts'],
  [
    'storage-no-orchestration',
    'src/storage/notes.ts',
    "export {safe} from '../indexer.js';",
    'src/indexer.ts',
  ],
  [
    'sqlite-acquisition',
    'src/searcher.ts',
    "import '../node_modules/better-sqlite3/index.js';",
    'node_modules/better-sqlite3/index.ts',
  ],
  [
    'infrastructure-no-transports',
    'src/chunk-embedding.ts',
    "void import('./stdio-server.js');",
    'src/stdio-server.ts',
  ],
  ['indexer-independent', 'src/indexer.ts', "import './searcher.js';", 'src/searcher.ts'],
  ['pure-normalization', 'src/text-normalization.ts', "export {safe} from './db.js';", 'src/db.ts'],
  [
    'infrastructure-no-transports',
    'src/storage/notes.ts',
    "import type {Value} from '../cli.js';",
    'src/cli.ts',
  ],
  [
    'infrastructure-no-transports',
    'src/embedder.ts',
    "void import('./mcp-runtime.js');",
    'src/mcp-runtime.ts',
  ],
])('rejects dependency rule %s', async (rule, file, source, target) => {
  const violations = await checkArchitecture(
    fixture({ [file]: source, [target]: 'export type Value = string; export const safe = 1;' }),
  );
  expect(violations.some((v) => v.includes(rule))).toBe(true);
});
it('rejects cycles and unlisted packages', async () => {
  const root = fixture({
    'src/a.ts': "import './b.js'; import 'unlisted';",
    'src/b.ts': "import './a.js';",
    'node_modules/unlisted/package.json': '{"name":"unlisted","main":"index.js"}',
    'node_modules/unlisted/index.js': 'module.exports = 1;',
  });
  const violations = await checkArchitecture(root);
  expect(violations.some((v) => v.includes('no-circular'))).toBe(true);
  expect(violations.some((v) => v.includes('no-unlisted-dependencies'))).toBe(true);
});
it('accepts typed storage operations and unrelated prepare/exec methods', async () => {
  const root = fixture({
    'src/db.ts': db,
    'src/storage/notes.ts':
      "import {getDb} from '../db.js'; export const rows = () => getDb().prepare('SELECT 1');",
    'src/searcher.ts':
      "import {safe} from './db.js'; import type {Value} from './value.js'; const helper = {prepare() {}, exec() {}}; helper.prepare(); helper.exec(); void import('./storage/notes.js'); export {safe};",
    'src/value.ts': 'export type Value = string;',
    'src/text-normalization.ts': 'export const normalize = (v: string) => v.normalize("NFD");',
  });
  expect(await checkArchitecture(root)).toEqual([]);
});
it('enforces boundaries on production sources', async () => {
  expect(await checkArchitecture(process.cwd())).toEqual([]);
}, 30_000);
