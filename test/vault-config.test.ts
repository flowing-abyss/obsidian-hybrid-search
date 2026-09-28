/* eslint-disable sonarjs/no-clear-text-protocols -- Synthetic .invalid fixture URLs are never fetched. */
import Database from 'better-sqlite3';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { applyDbConfigDefaults, closeDb, getDb, openDb, saveConfigMeta } from '../src/db.js';
import { discoverConfig, validateVaultPath } from '../src/vault-config.js';

const dbName = '.obsidian-hybrid-search.db';
let root: string;
let a: string;
let b: string;

function writeLocator(file: string, settings: Record<string, string>): void {
  const db = new Database(file);
  try {
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
    for (const [key, value] of Object.entries(settings)) insert.run(key, value);
  } finally {
    db.close();
  }
}

function seedCanonical(vault: string, label: 'A' | 'B'): void {
  vi.stubEnv('OBSIDIAN_VAULT_PATH', vault);
  openDb();
  saveConfigMeta({
    vaultPath: vault,
    apiBaseUrl: `http://${label.toLowerCase()}.invalid/v1`,
    apiModel: `model-${label}`,
  });
  getDb()
    .prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)')
    .run('ignore_patterns', JSON.stringify([`${label.toLowerCase()}-only/**`]));
  closeDb();
}

function assertNoDefaults(): void {
  assert.equal(process.env.OPENAI_BASE_URL, undefined);
  assert.equal(process.env.OPENAI_EMBEDDING_MODEL, undefined);
  assert.equal(process.env.OBSIDIAN_IGNORE_PATTERNS, undefined);
}

function bootstrapA(): void {
  openDb();
  applyDbConfigDefaults();
  assert.equal(config.apiBaseUrl, 'http://a.invalid/v1');
  assert.equal(config.apiModel, 'model-A');
  assert.deepEqual(config.ignorePatterns, ['a-only/**']);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'ohs-vault-config-'));
  a = path.join(root, 'A');
  b = path.join(root, 'B');
  mkdirSync(a);
  mkdirSync(b);
  for (const key of [
    'OBSIDIAN_VAULT_PATH',
    'OPENAI_BASE_URL',
    'OPENAI_EMBEDDING_MODEL',
    'OPENAI_API_KEY',
    'OBSIDIAN_IGNORE_PATTERNS',
  ])
    vi.stubEnv(key, undefined);
  vi.spyOn(process, 'cwd').mockReturnValue(b);
});

afterEach(() => {
  closeDb();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('selected vault routing', () => {
  for (const locator of ['absent', 'B', 'missing', 'corrupt'] as const) {
    it(`keeps explicit A independent of cwd B and ${locator} locator`, () => {
      seedCanonical(a, 'A');
      seedCanonical(b, 'B');
      vi.stubEnv('OBSIDIAN_VAULT_PATH', a);
      const corrupt = path.join(root, 'corrupt.db');
      writeFileSync(corrupt, 'not sqlite');
      const locatorPaths = {
        absent: undefined,
        B: path.join(b, dbName),
        missing: path.join(root, 'missing.db'),
        corrupt,
      };
      discoverConfig(locatorPaths[locator]);
      assert.equal(process.env.OBSIDIAN_VAULT_PATH, a);
      assertNoDefaults();
      bootstrapA();
      assert.equal(config.dbPath, path.join(a, dbName));
    });
  }

  it('does not hydrate foreign defaults or create a DB in a fresh explicit vault', () => {
    writeLocator(path.join(b, dbName), {
      vault_path: b,
      api_base_url: 'http://b.invalid/v1',
      api_model: 'model-B',
      ignore_patterns: '["b-only/**"]',
    });
    vi.stubEnv('OBSIDIAN_VAULT_PATH', a);
    discoverConfig();
    assert.equal(process.env.OBSIDIAN_VAULT_PATH, a);
    assertNoDefaults();
    assert.equal(existsSync(path.join(a, dbName)), false);
  });

  for (const kind of ['empty', 'whitespace', 'missing', 'file'] as const) {
    it(`rejects ${kind} explicit vault without falling back to B`, () => {
      const locator = path.join(b, dbName);
      writeLocator(locator, { vault_path: b, api_model: 'model-B' });
      const before = readFileSync(locator);
      const file = path.join(root, 'regular-file');
      writeFileSync(file, 'file');
      const values = { empty: '', whitespace: '   ', missing: path.join(root, 'missing'), file };
      vi.stubEnv('OBSIDIAN_VAULT_PATH', values[kind]);
      assert.throws(() => discoverConfig(locator), /OBSIDIAN_VAULT_PATH/);
      assert.equal(process.env.OBSIDIAN_VAULT_PATH, values[kind]);
      assertNoDefaults();
      assert.deepEqual(readFileSync(locator), before);
    });
  }

  it('preserves a symlink vault spelling and opens its canonical DB', () => {
    seedCanonical(a, 'A');
    const alias = path.join(root, 'alias-A');
    symlinkSync(a, alias, 'dir');
    vi.stubEnv('OBSIDIAN_VAULT_PATH', alias);
    discoverConfig(path.join(b, dbName));
    assert.equal(process.env.OBSIDIAN_VAULT_PATH, alias);
    bootstrapA();
    assert.equal(config.dbPath, path.join(alias, dbName));
  });

  it('selects the stored vault from an ancestor locator when env is absent', () => {
    writeLocator(path.join(b, dbName), { vault_path: b });
    const nested = path.join(b, 'nested', 'child');
    mkdirSync(nested, { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(nested);
    discoverConfig();
    assert.equal(process.env.OBSIDIAN_VAULT_PATH, b);
    assertNoDefaults();
  });

  it('selects a fresh ancestor .obsidian vault without creating a DB', () => {
    mkdirSync(path.join(a, '.obsidian'));
    const nested = path.join(a, 'nested');
    mkdirSync(nested);
    vi.spyOn(process, 'cwd').mockReturnValue(nested);
    discoverConfig();
    assert.equal(process.env.OBSIDIAN_VAULT_PATH, a);
    assert.equal(existsSync(path.join(a, dbName)), false);
  });

  it('keeps env and --db guidance when neither marker nor locator exists', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    assert.throws(() => discoverConfig(), /--db.*OBSIDIAN_VAULT_PATH/);
  });

  for (const storedVault of [true, false]) {
    it(`uses only the actual canonical DB defaults when the external copy ${storedVault ? 'stores' : 'omits'} vault_path`, () => {
      seedCanonical(a, 'A');
      const copy = path.join(storedVault ? b : a, 'copy.db');
      writeLocator(copy, {
        ...(storedVault ? { vault_path: a } : {}),
        api_base_url: 'http://foreign.invalid/v1',
        api_model: 'foreign-model',
        ignore_patterns: '["foreign/**"]',
      });
      const before = readFileSync(copy);
      vi.stubEnv('OBSIDIAN_VAULT_PATH', undefined);
      discoverConfig(copy);
      assert.equal(process.env.OBSIDIAN_VAULT_PATH, a);
      assertNoDefaults();
      bootstrapA();
      assert.equal(config.dbPath, path.join(a, dbName));
      assert.deepEqual(readFileSync(copy), before);
    });
  }

  it('does not inherit locator defaults when the selected canonical DB is absent', () => {
    const copy = path.join(b, 'copy.db');
    writeLocator(copy, {
      vault_path: a,
      api_model: 'foreign-model',
      ignore_patterns: '["foreign/**"]',
    });
    discoverConfig(copy);
    assert.equal(process.env.OBSIDIAN_VAULT_PATH, a);
    assertNoDefaults();
    assert.equal(existsSync(path.join(a, dbName)), false);
  });

  for (const kind of ['missing', 'corrupt', 'missing-settings'] as const) {
    it(`does not invent a target for a ${kind} locator and closes opened handles`, () => {
      const locator = path.join(b, 'copy.db');
      if (kind === 'corrupt') writeFileSync(locator, 'not sqlite');
      if (kind === 'missing-settings') new Database(locator).close();
      const close = vi.spyOn(Database.prototype, 'close');
      discoverConfig(locator);
      assert.equal(process.env.OBSIDIAN_VAULT_PATH, undefined);
      assertNoDefaults();
      if (kind !== 'missing') assert.equal(close.mock.calls.length, 1);
    });
  }

  it('requires a configured vault at direct startup', () => {
    assert.throws(() => validateVaultPath(undefined), /OBSIDIAN_VAULT_PATH/);
  });
});
