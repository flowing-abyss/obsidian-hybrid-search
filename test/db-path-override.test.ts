import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe('config.dbPath override', () => {
  it('honors OBSIDIAN_DB_PATH', () => {
    process.env.OBSIDIAN_DB_PATH = 'E:\\somewhere\\x.db';
    expect(config.dbPath).toBe('E:\\somewhere\\x.db');
  });
  it('honors legacy OBSIDIAN_HYBRID_DB_PATH', () => {
    delete process.env.OBSIDIAN_DB_PATH;
    process.env.OBSIDIAN_HYBRID_DB_PATH = 'E:\\legacy\\y.db';
    expect(config.dbPath).toBe('E:\\legacy\\y.db');
  });
  it('falls back to vault-relative default', () => {
    delete process.env.OBSIDIAN_DB_PATH;
    delete process.env.OBSIDIAN_HYBRID_DB_PATH;
    process.env.OBSIDIAN_VAULT_PATH = 'C:\\vault';
    expect(config.dbPath).toBe(path.join('C:\\vault', '.obsidian-hybrid-search.db'));
  });
});
