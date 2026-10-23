/**
 * Tests for --only-absolute-paths flag.
 *
 * Uses the compiled dist/src/cli.js (tsx cannot resolve ../../package.json
 * when running src/cli.ts directly — the relative path is written for the
 * compiled dist/src/ layout).  Run `npm run build` before this suite if the
 * dist/ tree is stale.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, it, vi } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'dist/src/cli.js');
const FIXTURE_VAULT = mkdtempSync(path.join(tmpdir(), 'ohs-cli-paths-'));
beforeAll(async () => {
  vi.stubEnv('OBSIDIAN_VAULT_PATH', FIXTURE_VAULT);
  const { openDb, initVecTable, upsertNote, closeDb } = await import('../src/storage/db.js');
  openDb();
  try {
    initVecTable(4);
    upsertNote({
      path: 'notes/Zettelkasten.md',
      title: 'Zettelkasten',
      tags: [],
      content: 'Zettelkasten organizes connected notes.',
      mtime: 1,
      hash: 'cli-path-fixture',
      chunks: [],
    });
  } finally {
    closeDb();
    vi.unstubAllEnvs();
  }
});
afterAll(() => rmSync(FIXTURE_VAULT, { recursive: true, force: true }));

function runCli(
  args: string[],
  env: Record<string, string> = {},
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf-8',
    cwd: ROOT,
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status ?? 1 };
}

describe('--only-absolute-paths flag', () => {
  it('appears in search --help output', () => {
    const { stdout } = runCli(['search', '--help']);
    assert.ok(
      stdout.includes('--only-absolute-paths'),
      `--only-absolute-paths missing from help:\n${stdout}`,
    );
  });

  it('--only-paths still outputs vault-relative paths', () => {
    const { stdout, status } = runCli(
      ['search', 'zettelkasten', '--only-paths', '--mode', 'fulltext'],
      { OBSIDIAN_VAULT_PATH: FIXTURE_VAULT },
    );
    assert.equal(status, 0, `CLI exited non-zero`);
    const lines = stdout.trim().split('\n').filter(Boolean);
    assert.deepEqual(lines, ['notes/Zettelkasten.md']);
    for (const line of lines) {
      assert.ok(!path.isAbsolute(line), `expected relative path, got: ${line}`);
    }
  });

  it('outputs absolute paths prefixed with vault root', () => {
    const { stdout, status } = runCli(
      ['search', 'zettelkasten', '--only-absolute-paths', '--mode', 'fulltext'],
      { OBSIDIAN_VAULT_PATH: FIXTURE_VAULT },
    );
    assert.equal(status, 0, `CLI exited non-zero`);
    const lines = stdout.trim().split('\n').filter(Boolean);
    assert.deepEqual(lines, [path.join(FIXTURE_VAULT, 'notes/Zettelkasten.md')]);
    for (const line of lines) {
      assert.ok(
        path.isAbsolute(line) && line.startsWith(FIXTURE_VAULT),
        `expected absolute path starting with vault root, got: ${line}`,
      );
    }
  });
});
