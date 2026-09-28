import Database from 'better-sqlite3';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

export function validateVaultPath(vaultPath: string | undefined): asserts vaultPath is string {
  if (vaultPath === undefined) {
    throw new Error('OBSIDIAN_VAULT_PATH environment variable is required');
  }
  if (vaultPath.trim().length === 0) {
    throw new Error('OBSIDIAN_VAULT_PATH must name an existing directory (received an empty path)');
  }
  let isDirectory = false;
  try {
    isDirectory = statSync(vaultPath).isDirectory();
  } catch {
    // Convert missing/unreadable paths to a stable startup diagnostic below.
  }
  if (!isDirectory) {
    throw new Error(`OBSIDIAN_VAULT_PATH must name an existing directory: ${vaultPath}`);
  }
}

/** Walk up from cwd looking for a file/dir with the given name. Returns the containing dir or undefined. */
function walkUpFind(name: string): string | undefined {
  let dir = process.cwd();
  while (true) {
    if (existsSync(path.join(dir, name))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Select the vault; defaults are restored later from its actual database connection. */
export function discoverConfig(dbPathOpt?: string): void {
  const explicitVault = process.env.OBSIDIAN_VAULT_PATH;
  if (explicitVault !== undefined) {
    validateVaultPath(explicitVault);
    return;
  }

  let dbFile: string | undefined = dbPathOpt;
  if (!dbFile) {
    const vaultDir = walkUpFind('.obsidian-hybrid-search.db');
    if (vaultDir) dbFile = path.join(vaultDir, '.obsidian-hybrid-search.db');
  }

  if (!dbFile) {
    const inferredVault = walkUpFind('.obsidian');
    if (inferredVault) {
      process.env.OBSIDIAN_VAULT_PATH = inferredVault;
      return;
    }
    throw new Error(
      'Could not find .obsidian-hybrid-search.db\n' +
        'Run this command from inside your Obsidian vault, use --db <path>, or set OBSIDIAN_VAULT_PATH.',
    );
  }

  try {
    // A locator supplies only the target vault, never its provider or ignore defaults.
    const db = new Database(dbFile, { readonly: true });
    try {
      const stored = db.prepare("SELECT value FROM settings WHERE key = 'vault_path'").get() as
        { value: string } | undefined;
      process.env.OBSIDIAN_VAULT_PATH = stored?.value || path.dirname(dbFile);
    } finally {
      db.close();
    }
  } catch {
    // DB unreadable — let normal startup errors surface without inventing a target.
  }
}
