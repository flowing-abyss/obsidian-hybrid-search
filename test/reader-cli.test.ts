import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('raw read preserves the entire source without validating content rules or opening an index', () => {
  const vault = mkdtempSync(path.join(tmpdir(), 'ohs-raw-read-'));
  const raw = '---\ntitle: Original title\n---\nOriginal %%knowledge%% body';
  writeFileSync(path.join(vault, 'source.md'), raw);
  try {
    const stdout = execFileSync(
      process.execPath,
      [fileURLToPath(new URL('../dist/src/cli.js', import.meta.url)), 'read', 'source.md', '--raw'],
      {
        env: {
          ...process.env,
          OBSIDIAN_VAULT_PATH: vault,
          OBSIDIAN_CONTENT_IGNORE_PATTERNS: '/invalid(/g',
        },
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    expect(stdout).toBe(`${raw}\n`);
    expect(existsSync(path.join(vault, '.obsidian-hybrid-search.db'))).toBe(false);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

it('raw read rejects path traversal and absolute paths without emitting outside content', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ohs-raw-boundary-'));
  const vault = path.join(root, 'vault');
  mkdirSync(vault);
  writeFileSync(path.join(root, 'secret.md'), 'OUTSIDE_RAW_PRIVATE_SENTINEL');
  try {
    for (const input of ['../secret.md', path.join(root, 'secret.md')]) {
      const result = spawnSync(
        process.execPath,
        [fileURLToPath(new URL('../dist/src/cli.js', import.meta.url)), 'read', input, '--raw'],
        { env: { ...process.env, OBSIDIAN_VAULT_PATH: vault }, encoding: 'utf8', timeout: 10_000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain('OUTSIDE_RAW_PRIVATE_SENTINEL');
      expect(result.stderr).toMatch(/vault-relative/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === 'win32')('raw read rejects a symlink to an outside note', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ohs-raw-link-'));
  const vault = path.join(root, 'vault');
  mkdirSync(vault);
  writeFileSync(path.join(root, 'secret.md'), 'OUTSIDE_RAW_PRIVATE_SENTINEL');
  symlinkSync(path.join(root, 'secret.md'), path.join(vault, 'linked.md'));
  try {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('../dist/src/cli.js', import.meta.url)), 'read', 'linked.md', '--raw'],
      { env: { ...process.env, OBSIDIAN_VAULT_PATH: vault }, encoding: 'utf8', timeout: 10_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('OUTSIDE_RAW_PRIVATE_SENTINEL');
    expect(result.stderr).toMatch(/symbolic links/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
