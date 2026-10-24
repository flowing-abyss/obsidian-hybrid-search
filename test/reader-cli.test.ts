import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
