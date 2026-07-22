import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let vault: string;
let originalVaultPath: string | undefined;
let originalDbPath: string | undefined;
let originalCleanupForce: string | undefined;
let originalCleanupMaxDeleteFraction: string | undefined;
beforeEach(() => {
  originalVaultPath = process.env.OBSIDIAN_VAULT_PATH;
  originalDbPath = process.env.OBSIDIAN_DB_PATH;
  originalCleanupForce = process.env.OBSIDIAN_CLEANUP_FORCE;
  originalCleanupMaxDeleteFraction = process.env.OBSIDIAN_CLEANUP_MAX_DELETE_FRACTION;
  vault = mkdtempSync(path.join(tmpdir(), 'ohs-scan-'));
  mkdirSync(path.join(vault, 'a'));
  writeFileSync(path.join(vault, 'a', 'one.md'), '# one');
  writeFileSync(path.join(vault, 'two.md'), '# two');
  process.env.OBSIDIAN_VAULT_PATH = vault;
  process.env.OBSIDIAN_DB_PATH = path.join(vault, 'test.db');
});
afterEach(() => {
  // isolate:false means this process is shared with every other suite in the
  // run - a leaked env var here silently breaks unrelated test files' db opens.
  if (originalVaultPath === undefined) delete process.env.OBSIDIAN_VAULT_PATH;
  else process.env.OBSIDIAN_VAULT_PATH = originalVaultPath;
  if (originalDbPath === undefined) delete process.env.OBSIDIAN_DB_PATH;
  else process.env.OBSIDIAN_DB_PATH = originalDbPath;
  if (originalCleanupForce === undefined) delete process.env.OBSIDIAN_CLEANUP_FORCE;
  else process.env.OBSIDIAN_CLEANUP_FORCE = originalCleanupForce;
  if (originalCleanupMaxDeleteFraction === undefined) {
    delete process.env.OBSIDIAN_CLEANUP_MAX_DELETE_FRACTION;
  } else {
    process.env.OBSIDIAN_CLEANUP_MAX_DELETE_FRACTION = originalCleanupMaxDeleteFraction;
  }
  rmSync(vault, { recursive: true, force: true });
});

describe('scanVault read-error reporting', () => {
  it('returns files plus empty readErrors on a clean scan', async () => {
    const { scanVault } = await import('../src/indexer.js');
    const result = scanVault();
    expect(result.files).toHaveLength(2);
    expect(result.readErrors).toEqual([]);
  });
  it('reports readErrors instead of silently dropping a subtree', async () => {
    // vi.spyOn on node:fs named exports fails under ESM ("Module namespace is
    // not configurable") - fall back to vi.mock/importOriginal per the module
    // graph, scoped to this test via resetModules + doUnmock.
    vi.resetModules();
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        // Simulate a Google Drive readdir failure on the 'a' subtree
        readdirSync: ((p: unknown, o: unknown) => {
          if (String(p).endsWith('a')) throw new Error('EIO: drive hiccup');
          return (actual.readdirSync as (p: unknown, o: unknown) => unknown)(p, o);
        }) as typeof actual.readdirSync,
      };
    });
    try {
      const { scanVault } = await import('../src/indexer.js');
      const result = scanVault();
      expect(result.readErrors).toHaveLength(1);
      expect(result.files.map((f) => path.basename(f))).toEqual(['two.md']);
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });
});

describe('cleanupStaleNotes mass-delete guard', () => {
  it('refuses to delete more than the configured fraction of the index', async () => {
    const { openDb, initVecTable, upsertNote, getDb, closeDb } = await import('../src/db.js');
    const { cleanupStaleNotes } = await import('../src/indexer.js');
    openDb();
    initVecTable(4);
    try {
      const db = getDb();
      for (let i = 0; i < 100; i++) {
        upsertNote({
          path: `note-${i}.md`,
          title: `Note ${i}`,
          tags: [],
          content: `content ${i}`,
          mtime: Date.now(),
          hash: `hash${i}`,
          chunks: [],
        });
      }
      // fsPaths claims 89 of 100 notes vanished
      const fsPaths = new Set(Array.from({ length: 11 }, (_, i) => `note-${i}.md`));
      cleanupStaleNotes(fsPaths);
      const count = (db.prepare('SELECT COUNT(*) AS c FROM notes').get() as { c: number }).c;
      expect(count).toBe(100); // guard tripped, nothing deleted
    } finally {
      closeDb();
    }
  });

  it('allows the same cleanup when OBSIDIAN_CLEANUP_FORCE=1', async () => {
    const { openDb, initVecTable, upsertNote, getDb, closeDb } = await import('../src/db.js');
    const { cleanupStaleNotes } = await import('../src/indexer.js');
    openDb();
    initVecTable(4);
    try {
      const db = getDb();
      for (let i = 0; i < 100; i++) {
        upsertNote({
          path: `note-${i}.md`,
          title: `Note ${i}`,
          tags: [],
          content: `content ${i}`,
          mtime: Date.now(),
          hash: `hash${i}`,
          chunks: [],
        });
      }
      process.env.OBSIDIAN_CLEANUP_FORCE = '1';
      const fsPaths = new Set(Array.from({ length: 11 }, (_, i) => `note-${i}.md`));
      cleanupStaleNotes(fsPaths);
      const count = (db.prepare('SELECT COUNT(*) AS c FROM notes').get() as { c: number }).c;
      expect(count).toBe(11);
    } finally {
      closeDb();
    }
  });
});
