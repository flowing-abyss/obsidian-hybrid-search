/* eslint-disable sonarjs/no-clear-text-protocols -- Synthetic .invalid fixture URLs are never fetched. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

let root: string;
let a: string;
let b: string;
let db: typeof import('../src/db.js');

beforeEach(async () => {
  vi.resetModules();
  root = mkdtempSync(path.join(tmpdir(), 'ohs-runtime-config-'));
  a = path.join(root, 'A');
  b = path.join(root, 'B');
  mkdirSync(a);
  mkdirSync(b);
  vi.stubEnv('OBSIDIAN_VAULT_PATH', a);
  for (const key of [
    'OPENAI_BASE_URL',
    'OPENAI_EMBEDDING_MODEL',
    'OPENAI_API_KEY',
    'OBSIDIAN_IGNORE_PATTERNS',
    'LOCAL_EMBEDDING_MODEL',
  ]) {
    vi.stubEnv(key, undefined);
  }
  db = await import('../src/db.js');
});

afterEach(() => {
  db.closeDb();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function seed(vault: string, apiBaseUrl: string, apiModel: string, ignore: string[]): void {
  vi.stubEnv('OBSIDIAN_VAULT_PATH', vault);
  db.openDb();
  db.initVecTable(4);
  db.saveConfigMeta({ vaultPath: vault, apiBaseUrl, apiModel });
  db.getDb()
    .prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)')
    .run('ignore_patterns', JSON.stringify(ignore));
  db.closeDb();
}

describe('MCP actual-vault configuration bootstrap', () => {
  it('hydrates A before embedding setup or saving metadata, regardless of cwd B', async () => {
    seed(a, 'http://a.invalid/v1', 'model-A', ['a-only/**']);
    seed(b, 'http://b.invalid/v1', 'model-B', ['b-only/**']);
    vi.stubEnv('OBSIDIAN_VAULT_PATH', a);
    vi.spyOn(process, 'cwd').mockReturnValue(b);
    const embedder = await import('../src/embedder.js');
    vi.spyOn(embedder, 'getContextLength').mockImplementation(() => {
      assert.equal(process.env.OPENAI_BASE_URL, 'http://a.invalid/v1');
      assert.equal(process.env.OPENAI_EMBEDDING_MODEL, 'model-A');
      assert.equal(process.env.OBSIDIAN_IGNORE_PATTERNS, 'a-only/**');
      return Promise.resolve(512);
    });
    const dimension = vi.spyOn(embedder, 'getEmbeddingDim').mockResolvedValue(8);
    const prime = vi.spyOn(embedder, 'primeEmbeddingDim').mockImplementation(() => {});
    const { createMcpRuntime } = await import('../src/mcp-runtime.js');
    const { config } = await import('../src/config.js');
    const runtime = await createMcpRuntime();
    assert.equal(runtime.modelName, 'model-A');
    assert.equal(runtime.embeddingDim, 4);
    assert.equal(config.apiBaseUrl, 'http://a.invalid/v1');
    assert.deepEqual(config.ignorePatterns, ['a-only/**']);
    const metadata = db
      .getDb()
      .prepare("SELECT value FROM settings WHERE key='api_model'")
      .get() as { value: string };
    assert.equal(metadata.value, 'model-A');
    assert.equal(dimension.mock.calls.length, 0);
    assert.deepEqual(prime.mock.calls, [[4]]);
  });

  it('keeps local mode when the stored provider URL is the OpenAI default and no key exists', async () => {
    seed(a, 'https://api.openai.com/v1', 'text-embedding-3-small', []);
    const embedder = await import('../src/embedder.js');
    vi.spyOn(embedder, 'getContextLength').mockResolvedValue(512);
    const dimension = vi.spyOn(embedder, 'getEmbeddingDim').mockResolvedValue(8);
    vi.spyOn(embedder, 'primeEmbeddingDim').mockImplementation(() => {});
    const { createMcpRuntime } = await import('../src/mcp-runtime.js');
    const runtime = await createMcpRuntime();
    assert.equal(runtime.modelName, 'local:Xenova/multilingual-e5-small');
    assert.equal(process.env.OPENAI_BASE_URL, undefined);
    assert.equal(dimension.mock.calls.length, 0);
  });

  for (const kind of ['absent', 'empty', 'whitespace', 'missing', 'file'] as const) {
    it(`rejects ${kind} explicit vault before opening or saving a database`, async () => {
      const file = path.join(root, 'regular-file');
      writeFileSync(file, 'not a directory');
      const values = {
        absent: undefined,
        empty: '',
        whitespace: '   ',
        missing: path.join(root, 'missing'),
        file,
      };
      vi.stubEnv('OBSIDIAN_VAULT_PATH', values[kind]);
      const open = vi.spyOn(db, 'openDb').mockImplementation(() => {
        throw new Error('unexpected database open');
      });
      const save = vi.spyOn(db, 'saveConfigMeta');
      const { createMcpRuntime } = await import('../src/mcp-runtime.js');
      await assert.rejects(createMcpRuntime(), /OBSIDIAN_VAULT_PATH/);
      assert.equal(open.mock.calls.length, 0);
      assert.equal(save.mock.calls.length, 0);
    });
  }
});
