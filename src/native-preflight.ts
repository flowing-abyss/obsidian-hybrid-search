import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getNativeHealCacheDir,
  isLikelyAbiFailure,
  tryAutoHealAbiMismatch,
  type NativeModule,
} from './auto-heal.js';

type RequireModule = (moduleName: string) => unknown;
type ClosableDatabase = { close(): void };
type DatabaseConstructor = new (filename: string) => ClosableDatabase;
type SqliteVecModule = { load(db: ClosableDatabase): void };

export interface NativePreflightDeps {
  cacheDir: string;
  runtimeVersion: string;
  runtimeAbi: string;
  platform: string;
  arch: string;
  modules: readonly NativeModule[];
  loadNativeModule(moduleName: NativeModule): void;
  writeStderrSync(message: string): void;
  exit(code: number): never;
  handleAbiFailure(message: string, moduleName: NativeModule): void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
}

function shortErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function recordStartupFailure(
  moduleName: NativeModule,
  err: unknown,
  deps: NativePreflightDeps,
): string {
  const message = errorMessage(err);
  const logPath = join(deps.cacheDir, 'last-startup-error.log');
  const banner =
    `\nobsidian-hybrid-search: Native module failed: ${moduleName}\n` +
    `  Node: ${deps.runtimeVersion} (ABI ${deps.runtimeAbi})\n` +
    `  Platform: ${deps.platform}-${deps.arch}\n` +
    `  Log: ${logPath}\n\n`;

  try {
    deps.writeStderrSync(banner + message + '\n');
  } catch {
    // Best effort: the process is already failing during startup.
  }

  try {
    mkdirSync(deps.cacheDir, { recursive: true });
    writeFileSync(
      logPath,
      `module: ${moduleName}\nnode: ${deps.runtimeVersion}\nabi: ${deps.runtimeAbi}\nplatform: ${deps.platform}-${deps.arch}\n\n${message}\n`,
    );
  } catch {
    // Best effort only.
  }

  return logPath;
}

function appendStartupFailureLog(logPath: string, message: string): void {
  try {
    appendFileSync(logPath, `\n${message}\n`);
  } catch {
    // Best effort only.
  }
}

export function loadNativeModuleWithRequire(
  moduleName: NativeModule,
  requireModule: RequireModule,
): void {
  const Database = requireModule('better-sqlite3') as DatabaseConstructor;
  const db = new Database(':memory:');

  try {
    if (moduleName === 'sqlite-vec') {
      const sqliteVec = requireModule('sqlite-vec') as SqliteVecModule;
      sqliteVec.load(db);
    }
  } finally {
    db.close();
  }
}

export function runNativeModulePreflight(deps: NativePreflightDeps): void {
  for (const moduleName of deps.modules) {
    try {
      deps.loadNativeModule(moduleName);
    } catch (err) {
      let recoveryError: unknown;

      if (moduleName === 'sqlite-vec' || isLikelyAbiFailure(String(err))) {
        try {
          deps.handleAbiFailure(shortErrorMessage(err), moduleName);
          deps.loadNativeModule(moduleName);
          continue;
        } catch (healErr) {
          recoveryError = healErr;
        }
      }

      const logPath = recordStartupFailure(moduleName, err, deps);
      if (recoveryError !== undefined) {
        const recoveryMessage = shortErrorMessage(recoveryError);
        try {
          deps.writeStderrSync(`\n${recoveryMessage}\n`);
        } catch {
          // Ignore secondary logging failures.
        }
        appendStartupFailureLog(logPath, recoveryMessage);
      }

      deps.exit(1);
    }
  }
}

export function defaultNativePreflightDeps(
  loadNativeModule: (moduleName: NativeModule) => void,
  writeStderrSync: (message: string) => void,
  exit: (code: number) => never,
): NativePreflightDeps {
  return {
    cacheDir: getNativeHealCacheDir(),
    runtimeVersion: process.version,
    runtimeAbi: process.versions.modules,
    platform: process.platform,
    arch: process.arch,
    modules: ['better-sqlite3', 'sqlite-vec'],
    loadNativeModule,
    writeStderrSync,
    exit,
    handleAbiFailure: tryAutoHealAbiMismatch,
  };
}
