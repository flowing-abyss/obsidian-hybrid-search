import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require_ = createRequire(import.meta.url);
const ABI_FAILURE_RE =
  /NODE_MODULE_VERSION|ERR_DLOPEN_FAILED|was compiled against a different Node\.js version|dlopen.*Symbol not found|incompatible architecture|Cannot find module 'sqlite-vec|Could not locate the bindings file|better_sqlite3\.node/i;

export interface SqliteBindingOptions {
  nativeBinding?: string;
}

export function isLikelyAbiFailure(error: unknown): boolean {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ERR_DLOPEN_FAILED') {
    return true;
  }
  return ABI_FAILURE_RE.test(String(error));
}

export function getSqliteBindingPath(
  moduleRoot = dirname(require_.resolve('better-sqlite3/package.json')),
): string {
  return join(moduleRoot, 'build', 'Release', 'better_sqlite3.node');
}

export function withSqliteNativeBinding<T>(
  open: (options: SqliteBindingOptions) => T,
  localBinding?: string,
): T {
  try {
    return open({});
  } catch (error) {
    if (!isLikelyAbiFailure(error)) throw error;
    const candidate = localBinding ?? getSqliteBindingPath();
    if (!existsSync(candidate)) throw error;
    // Upstream prefers a packaged prebuild even after a successful local rebuild.
    // Select that rebuild only when the ordinary native load cannot work.
    return open({ nativeBinding: candidate });
  }
}
