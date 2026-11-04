import Database from 'better-sqlite3';
import { withSqliteNativeBinding } from '../runtime/sqlite-binding.js';

/** Read a locator without acquiring the vault-bound singleton or provider defaults. */
export function readVaultLocator(dbFile: string): string | undefined {
  const db = withSqliteNativeBinding(
    (options) => new Database(dbFile, { readonly: true, ...options }),
  );
  try {
    const stored = db.prepare("SELECT value FROM settings WHERE key = 'vault_path'").get() as
      { value: string } | undefined;
    return stored?.value;
  } finally {
    db.close();
  }
}
