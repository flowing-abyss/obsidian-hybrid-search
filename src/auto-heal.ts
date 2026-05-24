import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type NativeModule = 'better-sqlite3' | 'sqlite-vec';

export interface AutoHealDeps {
  cacheDir: string;
  platform: string;
  arch: string;
  runtimeAbi: string;
  markerScope: string;
  now(): number;
  pid: number;
  resolveProjectRoot(): string;
  removeStaleBinary(moduleName: NativeModule): void;
  spawnDetached(
    command: string,
    args: readonly string[],
    options: { cwd: string; logPath: string },
  ): { pid?: number };
}

interface MarkerScopeIdentity {
  appVersion: string;
  nativeVersions: Partial<Record<NativeModule, string>>;
}

const require_ = createRequire(import.meta.url);
const ABI_FAILURE_RE =
  /NODE_MODULE_VERSION|ERR_DLOPEN_FAILED|was compiled against a different Node\.js version|dlopen.*Symbol not found|incompatible architecture|Cannot find module 'sqlite-vec|Could not locate the bindings file|better_sqlite3\.node/i;

export function isLikelyAbiFailure(msg: string): boolean {
  return ABI_FAILURE_RE.test(msg);
}

export function getNativeHealCacheDir(): string {
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'obsidian-hybrid-search');
}

function resolvePackageRoot(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const sourcePackageJson = resolve(currentDir, '../package.json');
  if (existsSync(sourcePackageJson)) return dirname(sourcePackageJson);
  return dirname(resolve(currentDir, '../../package.json'));
}

function readPackageVersion(packageJsonPath: string): string {
  try {
    return (
      (JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { version?: string }).version ?? ''
    );
  } catch {
    return '';
  }
}

function getDefaultMarkerScopeIdentity(projectRoot: string): MarkerScopeIdentity {
  const nativeVersions: Partial<Record<NativeModule, string>> = {};
  for (const moduleName of ['better-sqlite3', 'sqlite-vec'] as const) {
    try {
      nativeVersions[moduleName] = readPackageVersion(
        require_.resolve(`${moduleName}/package.json`),
      );
    } catch {
      nativeVersions[moduleName] = '';
    }
  }

  return {
    appVersion: readPackageVersion(join(projectRoot, 'package.json')),
    nativeVersions,
  };
}

function hashPath(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export function getNativeHealMarkerScope(
  projectRoot = resolvePackageRoot(),
  platform = process.platform,
  arch = process.arch,
  identity = getDefaultMarkerScopeIdentity(projectRoot),
): string {
  const identityKey = JSON.stringify({
    projectRoot,
    appVersion: identity.appVersion,
    nativeVersions: identity.nativeVersions,
  });
  return `${platform}-${arch}-${hashPath(identityKey)}`;
}

function defaultSpawnDetached(
  command: string,
  args: readonly string[],
  options: { cwd: string; logPath: string },
): { pid?: number } {
  const logFd = openSync(options.logPath, 'a');
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    detached: true,
    shell: process.platform === 'win32',
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();
  closeSync(logFd);
  return { pid: child.pid };
}

function getDefaultDeps(): AutoHealDeps {
  return {
    cacheDir: getNativeHealCacheDir(),
    platform: process.platform,
    arch: process.arch,
    runtimeAbi: process.versions.modules,
    markerScope: getNativeHealMarkerScope(),
    now: Date.now,
    pid: process.pid,
    resolveProjectRoot: resolvePackageRoot,
    removeStaleBinary: removeStaleBetterSqliteBinary,
    spawnDetached: defaultSpawnDetached,
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

function rebuildLogPath(moduleName: NativeModule, now: number, pid: number): string {
  return join(tmpdir(), `obsidian-hybrid-search-${moduleName}-rebuild-${now}-${pid}.log`);
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
    // Best-effort only. npm rebuild can still replace or rebuild the binary.
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
    `obsidian-hybrid-search: ${moduleName} requires manual recovery; run "npm rebuild better-sqlite3" in the obsidian-hybrid-search package, then restart your MCP client.\n` +
    `${reason}\n` +
    `Native module: ${moduleName}`
  );
}

export function clearNativeHealMarkers(
  modules: readonly NativeModule[],
  runtimeAbi: string,
  markerScope = getNativeHealMarkerScope(),
  cacheDir = getNativeHealCacheDir(),
): void {
  for (const moduleName of modules) {
    try {
      unlinkSync(markerPath(cacheDir, moduleName, runtimeAbi, markerScope));
    } catch {
      // Missing markers are expected on healthy starts.
    }
  }
}

export function tryAutoHealAbiMismatch(
  underlyingErr: string,
  moduleName: NativeModule,
  deps: AutoHealDeps = getDefaultDeps(),
): never {
  mkdirSync(deps.cacheDir, { recursive: true });

  if (deps.platform === 'win32') {
    throw new Error(manualInstructions(moduleName, 'automatic rebuild is disabled on Windows.'));
  }

  if (moduleName !== 'better-sqlite3') {
    throw new Error(
      manualInstructions(
        moduleName,
        'sqlite-vec native recovery currently requires manual repair.',
      ),
    );
  }

  const marker = markerPath(deps.cacheDir, moduleName, deps.runtimeAbi, deps.markerScope);
  if (!writeRetryMarker(marker, underlyingErr)) {
    throw new Error(
      `obsidian-hybrid-search: ABI rebuild already attempted for ${moduleName} on ABI ${deps.runtimeAbi}; run "npm rebuild better-sqlite3" manually, then restart your MCP client.`,
    );
  }

  deps.removeStaleBinary(moduleName);

  const cwd = deps.resolveProjectRoot();
  const logPath = rebuildLogPath(moduleName, deps.now(), deps.pid);
  const child = deps.spawnDetached('npm', ['rebuild', 'better-sqlite3'], { cwd, logPath });
  const pidSuffix = child.pid !== undefined ? ` (PID ${child.pid})` : '';

  throw new Error(
    `obsidian-hybrid-search: native rebuild started for ${moduleName}${pidSuffix}; restart your MCP client in about 1 minute.\n` +
      `Rebuild log: ${logPath}`,
  );
}
