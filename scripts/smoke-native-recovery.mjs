import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { smokeProcess } from './smoke-process.mjs';

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

  if (options.checkInstallWarnings) {
    assert.doesNotMatch(result.stderr, /npm warn deprecated/i);
    // Global npm 12 installs use the consumer's policy, not our root allowScripts.
    for (const line of result.stderr.split(/\r?\n/)) {
      if (!/^npm warn install-scripts[ \t]{2,}\S/.test(line)) continue;
      assert.match(
        line,
        /^npm warn install-scripts[ \t]+(?:obsidian-hybrid-search@\S+ \(prepare: |(?:onnxruntime-node|protobufjs)@\S+ \(postinstall: )/,
        'unexpected blocked install script',
      );
    }
    process.stderr.write(result.stderr);
  }
  if (options.quiet) {
    assert.equal(result.stdout, '', 'preflight wrote unexpected stdout');
    assert.equal(result.stderr, '', 'preflight wrote unexpected stderr');
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

function findLoadedBinding(packageRoot, nativeModuleRoot, env) {
  const nativeRoot = realpathSync(nativeModuleRoot) + path.sep;
  const binding = run(
    process.execPath,
    [
      '-e',
      `
    const requirePackage = require('node:module').createRequire(${JSON.stringify(path.join(packageRoot, 'package.json'))});
    const Database = requirePackage('better-sqlite3');
    const db = new Database(':memory:');
    db.close();
    const bindings = Object.keys(requirePackage.cache).filter(file =>
      file.startsWith(${JSON.stringify(nativeRoot)}) && file.endsWith('.node'));
    if (bindings.length !== 1) throw new Error('Expected one loaded SQLite binding');
    process.stdout.write(bindings[0]);
  `,
    ],
    { env },
  );
  assert.equal(path.dirname(binding), path.join(realpathSync(nativeModuleRoot), 'prebuilds'));
  return binding;
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
  for (const file of packedArtifacts[0].files) {
    assert.ok(
      !/^(?:\.ai|fixtures|docs|test|scripts)\//.test(file.path),
      `development file leaked into package: ${file.path}`,
    );
  }
  const tarball = path.join(artifactsDir, packedArtifacts[0].filename);
  assert.equal(existsSync(tarball), true, `packed tarball missing: ${tarball}`);

  const installArgs = [
    'install',
    '--global',
    '--prefix',
    globalPrefix,
    '--no-audit',
    '--no-fund',
    tarball,
  ];
  runNpm(installArgs, {
    env: { ...smokeEnv, NODE_GYP_FORCE_PYTHON: path.join(smokeRoot, 'unavailable-python') },
    checkInstallWarnings: true,
  });

  const globalNodeModules = runNpm(['root', '--global', '--prefix', globalPrefix], {
    env: smokeEnv,
  });
  const packageRoot = path.join(globalNodeModules, PACKAGE_NAME);
  const nativeModuleRoot = path.join(packageRoot, 'node_modules', 'better-sqlite3');
  const binding = path.join(nativeModuleRoot, 'build', 'Release', 'better_sqlite3.node');
  const sentinel = path.join(nativeModuleRoot, INSTALL_INSTANCE_FILE);
  const packagedPreflight = path.join(packageRoot, 'dist', 'src', 'runtime', 'preflight.js');
  const bundledBinding = findLoadedBinding(packageRoot, nativeModuleRoot, smokeEnv);
  const brokenBinary = 'intentionally broken native binding for recovery smoke\n';
  createFakeNpm(fakeBin);
  const tripwireEnv = {
    ...smokeEnv,
    PATH: `${fakeBin}${path.delimiter}${smokeEnv.PATH ?? ''}`,
    OHS_NPM_TRIPWIRE: npmTripwire,
  };

  assert.equal(
    existsSync(packagedPreflight),
    true,
    'packed dist/src/runtime/preflight.js is missing',
  );
  assert.equal(existsSync(binding), false, 'normal install unexpectedly compiled SQLite');
  run(process.execPath, [packagedPreflight], { env: tripwireEnv, quiet: true });
  assert.equal(existsSync(npmTripwire), false, 'normal startup invoked npm');
  assert.deepEqual(attemptMarkers(cacheDir), [], 'normal startup wrote recovery state');
  assert.deepEqual(sentinelEntries(nativeModuleRoot), [], 'sentinel exists before recovery');
  await smokeProcess(packageRoot, tripwireEnv);

  const blockedReinstallArgs = [
    ...installArgs.slice(0, -1),
    '--force',
    '--ignore-scripts',
    tarball,
  ];
  runNpm(blockedReinstallArgs, { env: smokeEnv, checkInstallWarnings: true });
  run(process.execPath, [packagedPreflight], { env: tripwireEnv, quiet: true });
  assert.equal(existsSync(npmTripwire), false, 'blocked-script installation needed npm at startup');
  assert.equal(existsSync(binding), false, 'blocked-script installation compiled SQLite');
  assert.deepEqual(attemptMarkers(cacheDir), []);
  assert.deepEqual(sentinelEntries(nativeModuleRoot), []);

  writeFileSync(bundledBinding, brokenBinary);
  run(process.execPath, [packagedPreflight], { env: smokeEnv, quiet: true });

  assert.equal(existsSync(binding), true, 'first preflight did not recover the native binding');
  assert.equal(
    readFileSync(bundledBinding, 'utf-8'),
    brokenBinary,
    'recovery changed the bundled binary',
  );
  assert.deepEqual(sentinelEntries(nativeModuleRoot), [INSTALL_INSTANCE_FILE]);
  const firstInstallInstance = readFileSync(sentinel, 'utf-8');
  assert.match(firstInstallInstance, UUID_RE);
  const firstMarkers = attemptMarkers(cacheDir);
  assert.equal(firstMarkers.length, 1, 'first recovery must create exactly one attempt marker');
  const firstSentinelEntries = sentinelEntries(nativeModuleRoot);
  assertNoInstallLogs(temporaryRoot);

  const healthyState = firstMarkers.map((name) => ({
    name,
    contents: readFileSync(path.join(cacheDir, name), 'utf-8'),
  }));
  run(process.execPath, [packagedPreflight], { env: tripwireEnv, quiet: true });

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
  await smokeProcess(packageRoot, tripwireEnv);

  writeFileSync(binding, brokenBinary);
  const repeatedFailure = spawnSync(process.execPath, [packagedPreflight], {
    env: tripwireEnv,
    encoding: 'utf-8',
  });
  assert.equal(repeatedFailure.error, undefined);
  assert.equal(repeatedFailure.status, 1);
  assert.match(repeatedFailure.stderr, /already attempted.*npm run build-release/);
  assert.equal(existsSync(npmTripwire), false, 'repeated failure attempted another build');
  assert.deepEqual(attemptMarkers(cacheDir), firstMarkers);
  assert.match(
    readFileSync(path.join(cacheDir, 'last-startup-error.log'), 'utf-8'),
    /Native|module: better-sqlite3/,
  );

  runNpm(blockedReinstallArgs, { env: smokeEnv, checkInstallWarnings: true });

  assert.equal(existsSync(binding), false, 'force reinstall retained the native binding');
  assert.deepEqual(
    sentinelEntries(nativeModuleRoot),
    [],
    'force reinstall retained the install-instance sentinel',
  );
  assert.deepEqual(attemptMarkers(cacheDir), firstMarkers, 'force reinstall changed old markers');
  run(process.execPath, [packagedPreflight], { env: tripwireEnv, quiet: true });
  assert.equal(existsSync(npmTripwire), false, 'healthy reinstall invoked npm');
  assert.deepEqual(sentinelEntries(nativeModuleRoot), []);

  writeFileSync(bundledBinding, brokenBinary);
  run(process.execPath, [packagedPreflight], { env: smokeEnv, quiet: true });

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
  console.log('  normal install -> no deprecation warnings, bundled binary, quiet startup');
  console.log('  blocked-script install -> no compiler or recovery needed');
  console.log(
    '  broken bundled binary -> local rebuild, successful reload and installed transports',
  );
  console.log('  healthy preflight -> no npm invocation and unchanged recovery state');
  console.log('  repeated failure -> one attempt retained, actionable diagnostics');
  console.log('  force reinstall -> new sentinel, second marker, and recovered binding');
} finally {
  rmSync(smokeRoot, { recursive: true, force: true });
}
