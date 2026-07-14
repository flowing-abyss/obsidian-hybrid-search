import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_NAME = 'obsidian-hybrid-search';
const INSTALL_INSTANCE_FILE = '.obsidian-hybrid-search-install-instance';
const ATTEMPT_MARKER_PREFIX = 'abi-heal-attempted-better-sqlite3-';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NPM_CLI = process.env.npm_execpath;

assert.ok(NPM_CLI, 'run this smoke through npm run test:native-recovery-smoke');

function commandFailure(command, args, result) {
  const error = result.error === undefined ? '' : `\nerror: ${result.error.message}`;
  return new Error(
    `${command} ${args.join(' ')} failed with status ${String(result.status)}` +
      `${error}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? PROJECT_ROOT,
    env: options.env ?? process.env,
    encoding: 'utf-8',
    shell: options.shell ?? false,
    stdio: 'pipe',
  });

  if (result.error !== undefined || result.status !== 0) {
    throw commandFailure(command, args, result);
  }

  return result.stdout.trim();
}

function runNpm(args, options = {}) {
  return run(process.execPath, [NPM_CLI, ...args], options);
}

function listFiles(root) {
  if (!existsSync(root)) return [];

  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(entryPath));
    } else {
      files.push(entryPath);
    }
  }
  return files.sort();
}

function attemptMarkers(cacheDir) {
  if (!existsSync(cacheDir)) return [];
  return readdirSync(cacheDir)
    .filter((name) => name.startsWith(ATTEMPT_MARKER_PREFIX))
    .sort();
}

function sentinelEntries(moduleRoot) {
  if (!existsSync(moduleRoot)) return [];
  return readdirSync(moduleRoot)
    .filter((name) => name.startsWith(INSTALL_INSTANCE_FILE))
    .sort();
}

function assertNoInstallLogs(temporaryRoot) {
  const logs = listFiles(temporaryRoot).filter((file) =>
    /^obsidian-hybrid-search-.+-install-.+\.log$/.test(path.basename(file)),
  );
  assert.deepEqual(logs, [], `successful install logs remain: ${logs.join(', ')}`);
}

function createFakeNpm(fakeBin) {
  mkdirSync(fakeBin, { recursive: true });

  const posixNpm = path.join(fakeBin, 'npm');
  writeFileSync(
    posixNpm,
    '#!/usr/bin/env node\n' +
      "require('node:fs').writeFileSync(process.env.OHS_NPM_TRIPWIRE, 'npm invoked\\n');\n" +
      'process.exit(97);\n',
  );
  chmodSync(posixNpm, 0o755);

  writeFileSync(
    path.join(fakeBin, 'npm.cmd'),
    '@echo off\r\n> "%OHS_NPM_TRIPWIRE%" echo npm invoked\r\nexit /b 97\r\n',
  );
}

const smokeRoot = mkdtempSync(path.join(tmpdir(), 'ohs-native-recovery-smoke-'));
const artifactsDir = path.join(smokeRoot, 'artifacts');
const globalPrefix = path.join(smokeRoot, 'global');
const cacheHome = path.join(smokeRoot, 'cache');
const cacheDir = path.join(cacheHome, PACKAGE_NAME);
const temporaryRoot = path.join(smokeRoot, 'tmp');
const npmCache = path.join(smokeRoot, 'npm-cache');
const fakeBin = path.join(smokeRoot, 'fake-bin');
const npmTripwire = path.join(smokeRoot, 'npm-tripwire');

for (const dir of [artifactsDir, globalPrefix, cacheHome, temporaryRoot, npmCache]) {
  mkdirSync(dir, { recursive: true });
}

const smokeEnv = {
  ...process.env,
  TMPDIR: temporaryRoot,
  TMP: temporaryRoot,
  TEMP: temporaryRoot,
  XDG_CACHE_HOME: cacheHome,
  npm_config_cache: npmCache,
  npm_config_audit: 'false',
  npm_config_fund: 'false',
  npm_config_update_notifier: 'false',
};

try {
  const npmVersion = runNpm(['--version'], { env: smokeEnv });
  assert.equal(
    npmVersion.split('.')[0],
    '12',
    `native recovery release smoke requires npm 12, received ${npmVersion}`,
  );

  const packResult = JSON.parse(
    runNpm(['pack', '--json', '--pack-destination', artifactsDir], { env: smokeEnv }),
  );
  const packedArtifacts = Object.values(packResult);
  assert.equal(packedArtifacts.length, 1, 'npm pack must produce exactly one tarball');
  const tarball = path.join(artifactsDir, packedArtifacts[0].filename);
  assert.equal(existsSync(tarball), true, `packed tarball missing: ${tarball}`);

  const installArgs = [
    'install',
    '--global',
    '--prefix',
    globalPrefix,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    tarball,
  ];
  runNpm(installArgs, { env: smokeEnv });

  const globalNodeModules = runNpm(['root', '--global', '--prefix', globalPrefix], {
    env: smokeEnv,
  });
  const packageRoot = path.join(globalNodeModules, PACKAGE_NAME);
  const nativeModuleRoot = path.join(packageRoot, 'node_modules', 'better-sqlite3');
  const binding = path.join(nativeModuleRoot, 'build', 'Release', 'better_sqlite3.node');
  const sentinel = path.join(nativeModuleRoot, INSTALL_INSTANCE_FILE);
  const packagedPreflight = path.join(packageRoot, 'dist', 'src', 'preflight.js');

  assert.equal(existsSync(packagedPreflight), true, 'packed dist/src/preflight.js is missing');
  assert.equal(existsSync(binding), false, 'binding exists after install with scripts blocked');
  assert.deepEqual(sentinelEntries(nativeModuleRoot), [], 'sentinel exists before recovery');

  run(process.execPath, [packagedPreflight], { env: smokeEnv });

  assert.equal(existsSync(binding), true, 'first preflight did not recover the native binding');
  assert.deepEqual(sentinelEntries(nativeModuleRoot), [INSTALL_INSTANCE_FILE]);
  const firstInstallInstance = readFileSync(sentinel, 'utf-8');
  assert.match(firstInstallInstance, UUID_RE);
  const firstMarkers = attemptMarkers(cacheDir);
  assert.equal(firstMarkers.length, 1, 'first recovery must create exactly one attempt marker');
  const firstSentinelEntries = sentinelEntries(nativeModuleRoot);
  assertNoInstallLogs(temporaryRoot);

  createFakeNpm(fakeBin);
  const healthyState = firstMarkers.map((name) => ({
    name,
    contents: readFileSync(path.join(cacheDir, name), 'utf-8'),
  }));
  run(process.execPath, [packagedPreflight], {
    env: {
      ...smokeEnv,
      PATH: `${fakeBin}${path.delimiter}${smokeEnv.PATH ?? ''}`,
      OHS_NPM_TRIPWIRE: npmTripwire,
    },
  });

  assert.equal(existsSync(npmTripwire), false, 'healthy preflight invoked npm');
  assert.equal(readFileSync(sentinel, 'utf-8'), firstInstallInstance);
  assert.deepEqual(
    sentinelEntries(nativeModuleRoot),
    firstSentinelEntries,
    'healthy preflight changed sentinel state',
  );
  assert.deepEqual(
    attemptMarkers(cacheDir).map((name) => ({
      name,
      contents: readFileSync(path.join(cacheDir, name), 'utf-8'),
    })),
    healthyState,
    'healthy preflight changed recovery state',
  );
  assertNoInstallLogs(temporaryRoot);

  runNpm([...installArgs.slice(0, -1), '--force', tarball], { env: smokeEnv });

  assert.equal(existsSync(binding), false, 'force reinstall retained the native binding');
  assert.deepEqual(
    sentinelEntries(nativeModuleRoot),
    [],
    'force reinstall retained the install-instance sentinel',
  );
  assert.deepEqual(attemptMarkers(cacheDir), firstMarkers, 'force reinstall changed old markers');

  run(process.execPath, [packagedPreflight], { env: smokeEnv });

  assert.equal(existsSync(binding), true, 'second preflight did not recover the native binding');
  assert.deepEqual(sentinelEntries(nativeModuleRoot), [INSTALL_INSTANCE_FILE]);
  const secondInstallInstance = readFileSync(sentinel, 'utf-8');
  assert.match(secondInstallInstance, UUID_RE);
  assert.notEqual(
    secondInstallInstance,
    firstInstallInstance,
    'reinstall reused the sentinel UUID',
  );
  const secondMarkers = attemptMarkers(cacheDir);
  assert.equal(secondMarkers.length, 2, 'second recovery must create one distinct attempt marker');
  assert.deepEqual(
    secondMarkers.filter((marker) => !firstMarkers.includes(marker)).length,
    1,
    'second recovery marker is not distinct',
  );
  assertNoInstallLogs(temporaryRoot);

  console.log(`native recovery packaged smoke passed with npm ${npmVersion}`);
  console.log('  blocked install -> recovered binding, sentinel, and first marker');
  console.log('  healthy preflight -> no npm invocation and unchanged recovery state');
  console.log('  force reinstall -> new sentinel, second marker, and recovered binding');
} finally {
  rmSync(smokeRoot, { recursive: true, force: true });
}
