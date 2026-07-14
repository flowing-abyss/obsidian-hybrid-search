import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export type NativeModule = 'better-sqlite3' | 'sqlite-vec';

interface InstallScriptResult {
  status: number | null;
  error?: Error;
}

interface InstallScriptOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  logPath: string;
  shell: boolean;
}

export interface AutoHealDeps {
  cacheDir: string;
  platform: string;
  runtimeAbi: string;
  now(): number;
  pid: number;
  resolveInstallInstanceId(moduleName: NativeModule): string;
  resolveNativeModuleRoot(moduleName: NativeModule): string;
  removeStaleBinary(moduleName: NativeModule): void;
  runInstallScript(options: InstallScriptOptions): InstallScriptResult;
}

export interface InstallInstanceDeps {
  pid: number;
  randomUUID(): string;
  readFileSync(path: string): string;
  openSync(path: string): number;
  writeSync(fd: number, value: string): number;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  linkSync(temporaryPath: string, finalPath: string): void;
  unlinkSync(path: string): void;
}

const require_ = createRequire(import.meta.url);
const INSTALL_INSTANCE_FILE = '.obsidian-hybrid-search-install-instance';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ABI_FAILURE_RE =
  /NODE_MODULE_VERSION|ERR_DLOPEN_FAILED|was compiled against a different Node\.js version|dlopen.*Symbol not found|incompatible architecture|Cannot find module 'sqlite-vec|Could not locate the bindings file|better_sqlite3\.node/i;

export function isLikelyAbiFailure(msg: string): boolean {
  return ABI_FAILURE_RE.test(msg);
}

export function getNativeHealCacheDir(): string {
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'obsidian-hybrid-search');
}

function hashPath(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function validateInstallInstanceId(value: string): string {
  if (!UUID_RE.test(value)) {
    throw new Error(
      `obsidian-hybrid-search: install instance sentinel contains invalid UUID: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function hasErrorCode(err: unknown, code: string): boolean {
  return err instanceof Error && 'code' in err && err.code === code;
}

const defaultInstallInstanceDeps: InstallInstanceDeps = {
  pid: process.pid,
  randomUUID,
  readFileSync: (path) => readFileSync(path, 'utf-8'),
  openSync: (path) => openSync(path, 'wx'),
  writeSync,
  fsyncSync,
  closeSync,
  linkSync,
  unlinkSync,
};

export function getOrCreateInstallInstanceId(
  moduleRoot: string,
  deps: InstallInstanceDeps = defaultInstallInstanceDeps,
): string {
  const finalPath = join(moduleRoot, INSTALL_INSTANCE_FILE);

  try {
    return validateInstallInstanceId(deps.readFileSync(finalPath));
  } catch (err) {
    if (!hasErrorCode(err, 'ENOENT')) throw err;
  }

  const installInstanceId = validateInstallInstanceId(deps.randomUUID());
  const temporaryPath = `${finalPath}.${deps.pid}.${installInstanceId}.tmp`;
  let temporaryCreated = false;

  try {
    const fd = deps.openSync(temporaryPath);
    temporaryCreated = true;
    try {
      let remaining = installInstanceId;
      while (remaining.length > 0) {
        const written = deps.writeSync(fd, remaining);
        if (written <= 0 || written > remaining.length) {
          throw new Error('obsidian-hybrid-search: failed to write install instance UUID');
        }
        remaining = remaining.slice(written);
      }
      deps.fsyncSync(fd);
    } finally {
      deps.closeSync(fd);
    }

    try {
      deps.linkSync(temporaryPath, finalPath);
      return installInstanceId;
    } catch (err) {
      if (!hasErrorCode(err, 'EEXIST')) throw err;
      return validateInstallInstanceId(deps.readFileSync(finalPath));
    }
  } finally {
    if (temporaryCreated) {
      try {
        deps.unlinkSync(temporaryPath);
      } catch {
        // A leftover temporary file or extra hard link is inert and must not mask publication.
      }
    }
  }
}

export function getNativeHealMarkerScope(installInstanceId: string): string {
  return hashPath(validateInstallInstanceId(installInstanceId));
}

function resolveNativeModuleRoot(moduleName: NativeModule): string {
  return dirname(require_.resolve(`${moduleName}/package.json`));
}

function defaultRunInstallScript(options: InstallScriptOptions): InstallScriptResult {
  const logFd = openSync(options.logPath, 'a');
  try {
    // npm is intentionally resolved from the user's PATH: the global package was installed by
    // that package-manager installation, and npm has no portable absolute executable location.
    const result = spawnSync(options.command, [...options.args], {
      cwd: options.cwd,
      shell: options.shell,
      stdio: ['ignore', logFd, logFd],
    });
    return {
      status: result.status,
      ...(result.error === undefined ? {} : { error: result.error }),
    };
  } finally {
    closeSync(logFd);
  }
}

function getDefaultDeps(): AutoHealDeps {
  return {
    cacheDir: getNativeHealCacheDir(),
    platform: process.platform,
    runtimeAbi: process.versions.modules,
    now: Date.now,
    pid: process.pid,
    resolveInstallInstanceId: (moduleName) =>
      getOrCreateInstallInstanceId(resolveNativeModuleRoot(moduleName)),
    resolveNativeModuleRoot,
    removeStaleBinary: removeStaleBetterSqliteBinary,
    runInstallScript: defaultRunInstallScript,
  };
}

function markerPath(
  cacheDir: string,
  moduleName: NativeModule,
  runtimeAbi: string,
  markerScope: string,
): string {
  return join(cacheDir, `abi-heal-attempted-${moduleName}-${runtimeAbi}-${markerScope}`);
}

function installLogPath(moduleName: NativeModule, now: number, pid: number): string {
  return join(tmpdir(), `obsidian-hybrid-search-${moduleName}-install-${now}-${pid}.log`);
}

function writeRetryMarker(path: string, underlyingErr: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'wx');
    writeSync(fd, `${new Date().toISOString()}\n${underlyingErr}\n`);
    return true;
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'EEXIST') return false;
    throw err;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function removeStaleBetterSqliteBinary(): void {
  try {
    const binaryPath = require_.resolve('better-sqlite3/build/Release/better_sqlite3.node');
    unlinkSync(binaryPath);
  } catch {
    // Best-effort only. The dependency install script can still replace or rebuild the binary.
  }
}

function manualInstructions(moduleName: NativeModule, reason: string): string {
  if (moduleName === 'sqlite-vec') {
    return (
      `obsidian-hybrid-search: sqlite-vec requires manual recovery; reinstall obsidian-hybrid-search or run "npm install" in its package directory, then restart your MCP client.\n` +
      `${reason}\n` +
      `Native module: ${moduleName}`
    );
  }

  return (
    `obsidian-hybrid-search: ${moduleName} requires manual recovery; run "npm run install" in the better-sqlite3 package directory, then restart your MCP client.\n` +
    `${reason}\n` +
    `Native module: ${moduleName}`
  );
}

export function tryAutoHealAbiMismatch(
  underlyingErr: string,
  moduleName: NativeModule,
  deps: AutoHealDeps = getDefaultDeps(),
): void {
  mkdirSync(deps.cacheDir, { recursive: true });

  if (moduleName !== 'better-sqlite3') {
    throw new Error(
      manualInstructions(
        moduleName,
        'sqlite-vec native recovery currently requires manual repair.',
      ),
    );
  }

  const installInstanceId = deps.resolveInstallInstanceId(moduleName);
  const markerScope = getNativeHealMarkerScope(installInstanceId);
  const marker = markerPath(deps.cacheDir, moduleName, deps.runtimeAbi, markerScope);
  if (!writeRetryMarker(marker, underlyingErr)) {
    throw new Error(
      `obsidian-hybrid-search: native install already attempted for ${moduleName} on ABI ${deps.runtimeAbi}; run "npm run install" in the better-sqlite3 package directory, then restart your MCP client.`,
    );
  }

  deps.removeStaleBinary(moduleName);

  const cwd = deps.resolveNativeModuleRoot(moduleName);
  const logPath = installLogPath(moduleName, deps.now(), deps.pid);
  let result: InstallScriptResult;
  try {
    result = deps.runInstallScript({
      command: 'npm',
      args: ['run', 'install'],
      cwd,
      logPath,
      shell: deps.platform === 'win32',
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `obsidian-hybrid-search: native install failed for ${moduleName}: ${reason}\n` +
        `Install log: ${logPath}`,
    );
  }

  if (result.status === 0) {
    try {
      unlinkSync(logPath);
    } catch {
      // Injected runners and already-cleaned logs do not necessarily leave a file behind.
    }
    // The marker permanently records that this install-instance/ABI combination consumed its
    // single automatic attempt, including after a successful install and reload.
    return;
  }

  const errorSuffix = result.error === undefined ? '' : `: ${result.error.message}`;
  throw new Error(
    `obsidian-hybrid-search: native install failed for ${moduleName} with status ${String(result.status)}${errorSuffix}.\n` +
      `Install log: ${logPath}`,
  );
}
