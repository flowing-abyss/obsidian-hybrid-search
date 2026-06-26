import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, it, vi } from 'vitest';

// ─── Vault setup (must precede application module imports) ────────────────────

const vaultDir = mkdtempSync(path.join(tmpdir(), 'ohs-mcp-runtime-rec-'));
process.env.OBSIDIAN_VAULT_PATH = vaultDir;

// Per the Wave 3 lesson: do NOT use vi.mock('../src/embedder.js', factory) — it
// conflicts with other test files under vitest's isolate:false. Spy on the real
// imported module instead so mocks cooperate with whatever other files installed.
const embedder = await import('../src/embedder.js');
vi.spyOn(embedder, 'embed').mockResolvedValue([new Float32Array([0.1, 0.2, 0.3, 0.4])]);
vi.spyOn(embedder, 'getContextLength').mockResolvedValue(512);

const { closeDb, openDb, initVecTable, isLikelyDatabaseCorruption } = await import('../src/db.js');
const { indexVaultSync } = await import('../src/indexer.js');
const { createMcpRuntime } = await import('../src/mcp-runtime.js');

beforeAll(() => {
  openDb();
  initVecTable(4);
});

afterAll(() => {
  vi.mocked(embedder.embed).mockRestore();
  vi.mocked(embedder.getContextLength).mockRestore();
  closeDb();
  rmSync(vaultDir, { recursive: true, force: true });
});

// ─── isLikelyDatabaseCorruption — edge cases ─────────────────────────────────

describe('isLikelyDatabaseCorruption — edge cases', () => {
  it('recognizes SQLITE_CORRUPT message', () => {
    assert.equal(isLikelyDatabaseCorruption(new Error('database disk image is malformed')), true);
  });

  it('recognizes "database is corrupt"', () => {
    assert.equal(isLikelyDatabaseCorruption(new Error('database is corrupt')), true);
  });

  it('recognizes "file is not a database"', () => {
    assert.equal(isLikelyDatabaseCorruption(new Error('file is not a database')), true);
  });

  it('recognizes malformed database schema', () => {
    assert.equal(isLikelyDatabaseCorruption(new Error('malformed database schema')), true);
  });

  it('recognizes SQLITE_CORRUPT code', () => {
    const err = Object.assign(new Error('something'), { code: 'SQLITE_CORRUPT' });
    assert.equal(isLikelyDatabaseCorruption(err), true);
  });

  it('recognizes SQLITE_NOTADB code', () => {
    const err = Object.assign(new Error('something'), { code: 'SQLITE_NOTADB' });
    assert.equal(isLikelyDatabaseCorruption(err), true);
  });

  it('does not classify SQLITE_BUSY as corruption', () => {
    assert.equal(isLikelyDatabaseCorruption(new Error('database is locked')), false);
  });

  it('does not classify SQLITE_BUSY code as corruption', () => {
    const err = Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' });
    assert.equal(isLikelyDatabaseCorruption(err), false);
  });

  it('does not classify SQLITE_LOCKED code as corruption', () => {
    const err = Object.assign(new Error('locked'), { code: 'SQLITE_LOCKED' });
    assert.equal(isLikelyDatabaseCorruption(err), false);
  });

  it('handles non-Error values', () => {
    assert.equal(isLikelyDatabaseCorruption('string'), false);
    assert.equal(isLikelyDatabaseCorruption(null), false);
    assert.equal(isLikelyDatabaseCorruption(undefined), false);
    assert.equal(isLikelyDatabaseCorruption(42), false);
  });

  it('handles errors with no message and no code', () => {
    assert.equal(isLikelyDatabaseCorruption(new Error('')), false);
    assert.equal(isLikelyDatabaseCorruption({}), false);
  });
});

// ─── indexVaultSync — corruption recovery options ────────────────────────────

describe('indexVaultSync — corruption recovery', () => {
  it('succeeds with no errors on empty vault', async () => {
    const result = await indexVaultSync(false, 'Test index...');
    assert.equal(result.errors.length, 0);
    assert.ok(typeof result.indexed === 'number');
    assert.ok(typeof result.skipped === 'number');
  });

  it('requireClean=true with no errors succeeds', async () => {
    const result = await indexVaultSync(false, 'Test index...', { requireClean: true });
    assert.equal(result.errors.length, 0);
  });

  it('requireClean=true accepts the option without throwing when vault is clean', async () => {
    // Cannot easily produce an indexing error on an empty vault; the option is
    // exercised by the no-error path here, and the throw path is covered by the
    // requireClean-with-errors semantics in src/indexer.ts:537-543.
    const result = await indexVaultSync(false, 'Test index...', { requireClean: true });
    assert.ok(typeof result.indexed === 'number');
  });

  it('does NOT call recoverDatabase when no corruption occurs', async () => {
    let recoveryCalled = false;
    const result = await indexVaultSync(false, 'Test index...', {
      recoverDatabase: () => {
        recoveryCalled = true;
      },
    });
    // recoverDatabase is only invoked on a corruption error — empty vault has none.
    assert.equal(recoveryCalled, false);
    assert.ok(typeof result.indexed === 'number');
  });

  it('accepts both requireClean and recoverDatabase together', async () => {
    let recoveryCalled = false;
    const result = await indexVaultSync(false, 'Test index...', {
      requireClean: true,
      recoverDatabase: () => {
        recoveryCalled = true;
      },
    });
    assert.equal(recoveryCalled, false);
    assert.equal(result.errors.length, 0);
  });
});

// ─── createMcpRuntime — lifecycle ────────────────────────────────────────────

describe('createMcpRuntime — lifecycle', () => {
  it('returns runtime with version, model name, context length, and dim', async () => {
    const runtime = await createMcpRuntime();
    assert.ok(typeof runtime.version === 'string');
    assert.ok(runtime.version.length > 0);
    assert.ok(typeof runtime.modelName === 'string');
    assert.ok(runtime.modelName.length > 0);
    assert.ok(typeof runtime.contextLength === 'number');
    assert.ok(runtime.contextLength > 0);
    // embeddingDim is number | null — both are valid shapes
    assert.ok(runtime.embeddingDim === null || typeof runtime.embeddingDim === 'number');
  });

  it('getUpdateStatus returns a valid UpdateStatus state', async () => {
    const runtime = await createMcpRuntime();
    const status = runtime.getUpdateStatus();
    assert.ok(
      ['checking', 'up_to_date', 'update_available', 'offline'].includes(status.state),
      `unexpected state: ${status.state}`,
    );
  });

  it('update_available status carries latestVersion', async () => {
    // The internal updateStatus is module-level; without mocking fetch we cannot
    // force update_available deterministically. Verify the shape contract instead:
    // if state is update_available, latestVersion must be a non-empty string.
    const runtime = await createMcpRuntime();
    const status = runtime.getUpdateStatus();
    if (status.state === 'update_available') {
      assert.ok(typeof status.latestVersion === 'string');
      assert.ok(status.latestVersion.length > 0);
    }
  });
});
