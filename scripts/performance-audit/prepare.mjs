import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const model = 'Xenova/multilingual-e5-small';
const packageName = 'obsidian-hybrid-search-0.16.4.tgz';
const revisions = {
  base: {
    commit: '8109080ae62abb60504cf14a118dd75a464cf9d3',
    lock: 'f2bb72442a1ae33fe3cf4f4c1bbad080074d57d9c78615e79cc940a64e21cada',
    package: '9c4ef2a4dbcd5875603def83c35f48638c20cc3707f1df471515e8e6960de3c8',
  },
  candidate: {
    commit: '308437b01ead87a95d91cc193ebe73c408e6f815',
    lock: '1b4a0903adb87ee93412af2c98792590a77524a3392643ac5fc95ba8c18b64e5',
    package: 'a8066d4d93a05a18d94f9969caab919814c705c5a36e2ecc861ed0f9f025b52b',
  },
};
const inputHashes = {
  'corpus-manifest.json': '9181479b4410f94475b67fcd1a7561c6c62f5237b179eabcca8b23b7a8be0cdb',
  'ohs-acceptance-corpus.json': '71a47fca70d51528d7e3816fd7bef6c78c79352a5386ab13e84f35cb21cc93a6',
  'queries.json': '5ebdaf38950df0520fc4cf9f811bb70a83c7908cede97dc9f42e2e75c591c4e0',
  'required-facts.json': 'e08ffb5491cca3804b867033b0a7156727573f4365eb54bae158e2ebe86541c0',
  'runtime-manifest.json': '40e2580f2b8e9f18e24b2ad4518f360c85f8f627e57f470c74aa4c7837570196',
  'runtime-source-commit.json': 'd99313f13ebec62e085647e4985abff203cdd9a3e7ebc0fe431ffe108cc21519',
  'model-artifacts.json': '2c84d230c7019739412becfbfa9a394ddbdfa4216d9fc84e62aad174e3ecab54',
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const isHash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function archiveEvidence(root, destination) {
  assert.ok(!fs.existsSync(destination), 'Keep existing evidence instead of replacing an artifact');
  const selected = [];
  if (fs.existsSync(root)) {
    for (const item of fs.readdirSync(root, { withFileTypes: true })) {
      const evidenceDirectory = ['preparation', 'runs', 'harness-archives'].includes(item.name);
      const evidenceFile =
        /^(?:quiet-initial-(?:measurements|host)-|closures-|cleanup-|descendants-after-cleanup-)/.test(
          item.name,
        ) || /\.(?:mjs|json|md)$/.test(item.name);
      if (!evidenceDirectory && !evidenceFile) continue;
      safePath(root, item.name);
      if (evidenceDirectory) {
        assert.ok(item.isDirectory(), `Expected evidence directory: ${item.name}`);
        selected.push(
          ...inventory(path.join(root, item.name)).map((name) => `${item.name}/${name}`),
        );
      } else {
        assert.ok(item.isFile(), `Expected evidence file: ${item.name}`);
        selected.push(item.name);
      }
    }
  }
  const files = selected.sort().map((name) => {
    const bytes = fs.readFileSync(safePath(root, name));
    return { path: name, bytes: bytes.length, sha256: sha256(bytes) };
  });
  fs.mkdirSync(destination, { recursive: true });
  for (const file of files) {
    const target = safePath(destination, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(safePath(root, file.path), target, fs.constants.COPYFILE_EXCL);
  }
  const report = {
    status: fs.existsSync(root) ? 'evidence-staged' : 'no-preparation-output',
    files,
  };
  fs.writeFileSync(
    path.join(destination, 'artifact-manifest.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  return report;
}

function safePath(root, relative) {
  assert.ok(typeof relative === 'string' && relative.length > 0, 'Invalid relative path');
  assert.ok(
    !relative.includes('\\') && !relative.includes('\0') && !relative.includes(':'),
    `Invalid path: ${relative}`,
  );
  assert.ok(
    !path.posix.isAbsolute(relative) &&
      relative.split('/').every((part) => part && part !== '.' && part !== '..'),
    `Unsafe path: ${relative}`,
  );
  let current = path.resolve(root);
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    try {
      assert.ok(!fs.lstatSync(current).isSymbolicLink(), `Refusing symbolic link: ${relative}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return current;
}

function entriesChecked(entries, label) {
  assert.ok(Array.isArray(entries) && entries.length > 0, `${label}: invalid manifest`);
  const paths = new Set();
  for (const entry of entries) {
    assert.ok(entry && typeof entry.path === 'string', `${label}: invalid manifest entry`);
    // Validate lexical containment before looking at any filesystem paths.
    assert.ok(
      !entry.path.includes('\\') &&
        !entry.path.includes('\0') &&
        !entry.path.includes(':') &&
        !path.posix.isAbsolute(entry.path) &&
        entry.path.split('/').every((part) => part && part !== '.' && part !== '..'),
      `${label}: unsafe path ${entry.path}`,
    );
    assert.ok(isHash(entry.sha256), `${label}: invalid hash for ${entry.path}`);
    assert.ok(
      entry.bytes === undefined || (Number.isSafeInteger(entry.bytes) && entry.bytes >= 0),
      `${label}: invalid bytes for ${entry.path}`,
    );
    const normalized = entry.path.normalize('NFC');
    assert.ok(!paths.has(normalized), `${label}: duplicate path ${entry.path}`);
    paths.add(normalized);
  }
  return paths;
}

function inventory(root, relative = '') {
  const found = [];
  for (const item of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${item.name}` : item.name;
    assert.ok(!item.isSymbolicLink(), `Refusing symbolic link: ${name}`);
    if (item.isDirectory()) found.push(...inventory(root, name));
    else {
      assert.ok(item.isFile(), `Refusing non-regular file: ${name}`);
      found.push(name);
    }
  }
  return found;
}

function verifyEntries(root, entries, label, { allowMissing = false } = {}) {
  entriesChecked(entries, label);
  const files = [];
  const missing = [];
  for (const entry of entries) {
    const file = safePath(root, entry.path);
    if (!fs.existsSync(file)) {
      if (allowMissing) {
        missing.push(entry.path);
        continue;
      }
      throw new Error(`${label}: missing ${entry.path}`);
    }
    assert.ok(fs.statSync(file).isFile(), `${label}: expected regular file ${entry.path}`);
    const bytes = fs.readFileSync(file);
    assert.equal(
      sha256(bytes),
      entry.sha256,
      `${label}: hash mismatch for ${entry.path}; preserve the frozen input and investigate`,
    );
    if (entry.bytes !== undefined)
      assert.equal(bytes.length, entry.bytes, `${label}: bytes mismatch for ${entry.path}`);
    files.push({ path: entry.path, bytes: bytes.length, sha256: entry.sha256 });
  }
  return { files, missing };
}

export function verifyCorpus(root, manifest) {
  const expected = entriesChecked(manifest?.files, 'corpus');
  assert.ok(
    manifest.files.every((file) => Number.isSafeInteger(file.bytes) && file.bytes >= 0),
    'corpus: manifest requires byte counts',
  );
  const actual = inventory(root).map((file) => file.normalize('NFC'));
  assert.equal(new Set(actual).size, actual.length, 'corpus: duplicate canonical paths');
  for (const name of actual) assert.ok(expected.has(name), `corpus: unexpected ${name}`);
  for (const name of expected) assert.ok(actual.includes(name), `corpus: missing ${name}`);
  const verified = verifyEntries(root, manifest.files, 'corpus');
  return {
    files: verified.files.length,
    bytes: verified.files.reduce((sum, file) => sum + file.bytes, 0),
  };
}

export function materializeSyntheticNotes(root, acceptance) {
  assert.ok(
    Array.isArray(acceptance?.notes) && acceptance.notes.length > 0,
    'Invalid synthetic notes',
  );
  const entries = acceptance.notes.map((note) => {
    assert.equal(typeof note?.content, 'string', 'Invalid synthetic note content');
    return { path: note.path, sha256: sha256(note.content) };
  });
  entriesChecked(entries, 'synthetic notes');
  const destinations = entries.map((entry) => safePath(root, entry.path));
  for (const file of destinations)
    assert.ok(!fs.existsSync(file), `Refusing to overwrite existing note: ${file}`);
  for (const [index, file] of destinations.entries()) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, acceptance.notes[index].content, { flag: 'wx' });
  }
}

export function verifyModelCache(cache, artifacts, { allowMissing = false } = {}) {
  assert.ok(Array.isArray(artifacts?.files), 'Invalid model manifest');
  const selected = artifacts.files.filter((file) => file.model === model);
  assert.deepEqual(
    selected.map((file) => file.file).sort(),
    ['config.json', 'onnx/model_quantized.onnx', 'tokenizer.json', 'tokenizer_config.json'],
    'model: expected exactly the four frozen E5 artifacts',
  );
  assert.ok(
    selected.every((file) => Number.isSafeInteger(file.bytes) && file.bytes >= 0),
    'model: manifest requires byte counts',
  );
  return verifyEntries(
    cache,
    selected.map((file) => ({ ...file, path: `${model}/${file.file}` })),
    'model',
    { allowMissing },
  );
}

export function validateProvenance(runtime, source) {
  assert.equal(runtime?.original, revisions.base.commit, 'provenance: original source mismatch');
  assert.equal(
    runtime?.candidate_head,
    revisions.candidate.commit,
    'provenance: candidate source mismatch',
  );
  assert.equal(source?.commit, revisions.candidate.commit, 'provenance: candidate record mismatch');
  assert.equal(runtime?.node, '26.12.0', 'provenance: Node mismatch');
  assert.equal(runtime?.npm, '12.2.0', 'provenance: npm mismatch');
  assert.equal(source.base, runtime.candidate_base, 'provenance: candidate base mismatch');
  assert.ok(isHash(source.committedDiffSha256), 'provenance: invalid source diff hash');
  assert.equal(
    source.committedDiffSha256,
    runtime.candidate_diff_sha256,
    'provenance: source diff mismatch',
  );
  for (const [label, pin] of Object.entries(revisions)) {
    assert.equal(
      runtime.runtime?.[label]?.['package-lock.json'],
      pin.lock,
      `provenance: ${label} lock mismatch`,
    );
    assert.equal(
      runtime.runtime?.[label]?.[packageName],
      pin.package,
      `provenance: ${label} package mismatch`,
    );
  }
  assert.equal(
    source.packageSha256,
    revisions.candidate.package,
    'provenance: candidate package mismatch',
  );
}

export function readFrozenInputs(root) {
  const parsed = {};
  for (const [name, hash] of Object.entries(inputHashes)) {
    verifyEntries(root, [{ path: name, sha256: hash }], 'frozen input');
    parsed[name] = JSON.parse(fs.readFileSync(safePath(root, name), 'utf8'));
  }
  const result = {
    corpus: parsed['corpus-manifest.json'],
    acceptance: parsed['ohs-acceptance-corpus.json'],
    queries: parsed['queries.json'],
    facts: parsed['required-facts.json'],
    runtime: parsed['runtime-manifest.json'],
    source: parsed['runtime-source-commit.json'],
    models: parsed['model-artifacts.json'],
  };
  validateProvenance(result.runtime, result.source);
  assert.equal(result.corpus.files.length, 1393, 'Frozen corpus count');
  assert.equal(result.acceptance.notes.length, 36, 'Frozen synthetic count');
  assert.equal(result.queries.length, 110, 'Frozen query count');
  assert.equal(result.corpus.query_sha256, inputHashes['queries.json'], 'Frozen query provenance');
  return result;
}

export function verifyRuntime(root, expected) {
  assert.ok(
    expected?.compiled_files && Object.keys(expected.compiled_files).length > 0,
    'runtime: invalid compiled manifest',
  );
  const compiled = Object.entries(expected.compiled_files).map(([name, hash]) => ({
    path: name,
    sha256: hash,
  }));
  const compiledPaths = entriesChecked(compiled, 'runtime');
  for (const file of inventory(path.join(root, 'dist/src'))) {
    assert.ok(compiledPaths.has(`dist/src/${file}`), `runtime: unexpected compiled file ${file}`);
  }
  const checked = verifyEntries(
    root,
    [
      ...['package.json', 'package-lock.json', packageName].map((name) => ({
        path: name,
        sha256: expected[name],
      })),
      ...compiled,
    ],
    'runtime',
  );
  return { compiledFiles: compiled.length, files: checked.files };
}

function writeJson(root, name, value) {
  const file = safePath(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function normalizePackage(
  root,
  label,
  expectedSha256,
  { gzipExecutable = '/usr/bin/gzip' } = {},
) {
  const relative = `runtime/${label}/${packageName}`;
  const file = safePath(root, relative);
  const diagnostic = `preparation/${label}-package-normalization.json`;
  const maximumBytes = 16 * 1024 * 1024;
  const report = {
    status: 'normalizing',
    package: relative,
    expectedSha256,
    node: process.version,
    versions: process.versions,
    compressor: { executable: gzipExecutable },
  };
  const persist = () => writeJson(root, diagnostic, report);
  const describe = (bytes) => ({ bytes: bytes.length, sha256: sha256(bytes) });
  function compress(args, input, version = false) {
    const result = spawnSync(gzipExecutable, args, {
      input,
      maxBuffer: version ? 8192 : maximumBytes,
      timeout: version ? 5000 : 30000,
      killSignal: 'SIGKILL',
    });
    report.compressor[version ? 'version' : 'result'] = {
      args,
      status: result.status,
      signal: result.signal,
      error: result.error?.message,
      stdout: version ? result.stdout?.toString('utf8').trim() : undefined,
      stdoutBytes: result.stdout?.length,
      stdoutSha256: result.stdout ? sha256(result.stdout) : undefined,
      stderr: result.stderr?.subarray(0, 8192).toString('utf8').trim(),
    };
    persist();
    if (result.error || result.status !== 0 || result.signal !== null) {
      throw new Error(
        `${label}: gzip compressor ${version ? 'version check' : 'execution'} failed; inspect ${diagnostic} and preserve the frozen pins`,
        { cause: result.error },
      );
    }
    return result.stdout;
  }
  persist();
  try {
    assert.ok(isHash(expectedSha256), `${label}: invalid frozen package SHA`);
    const stat = fs.statSync(file);
    assert.ok(
      stat.isFile() && stat.size <= maximumBytes,
      `${label}: package exceeds the 16 MiB input bound`,
    );
    const fresh = fs.readFileSync(file);
    report.fresh = describe(fresh);
    persist();
    compress(['--version'], undefined, true);
    const raw = gunzipSync(fresh, { maxOutputLength: maximumBytes });
    report.rawTar = describe(raw);
    persist();
    const canonical = compress(['-n', '-9'], raw);
    assert.ok(
      canonical.length >= 10 && canonical.subarray(0, 3).equals(Buffer.from([31, 139, 8])),
      `${label}: compressor did not produce gzip`,
    );
    // npm's portable tar format uses OS=255; preserve every uncompressed tar byte.
    canonical[9] = 255;
    report.canonical = describe(canonical);
    persist();
    assert.ok(
      gunzipSync(canonical, { maxOutputLength: maximumBytes }).equals(raw),
      `${label}: compressor changed the uncompressed tar bytes`,
    );
    assert.equal(
      report.canonical.sha256,
      expectedSha256,
      `${label} package: hash mismatch after gzip normalization; preserve the frozen input and investigate`,
    );
    report.status = fresh.equals(canonical) ? 'already-pinned' : 'normalized';
    persist();
    if (!fresh.equals(canonical)) {
      const temporary = safePath(root, `${relative}.canonical`);
      const descriptor = fs.openSync(temporary, 'wx');
      try {
        try {
          fs.writeFileSync(descriptor, canonical);
        } finally {
          fs.closeSync(descriptor);
        }
        fs.renameSync(temporary, file);
      } catch (error) {
        fs.rmSync(temporary, { force: true });
        throw error;
      }
    }
    return report;
  } catch (error) {
    report.status = 'failed';
    report.error = { name: error.name, message: error.message, code: error.code };
    persist();
    throw error;
  }
}

function run(root, label, command, args, cwd) {
  const directory = path.join(root, 'preparation');
  fs.mkdirSync(directory, { recursive: true });
  const stdout = fs.openSync(path.join(directory, `${label}.stdout.txt`), 'wx');
  const stderr = fs.openSync(path.join(directory, `${label}.stderr.txt`), 'wx');
  const beganAt = new Date().toISOString();
  let result;
  try {
    result = spawnSync(command, args, { cwd, env: process.env, stdio: ['ignore', stdout, stderr] });
  } finally {
    fs.closeSync(stdout);
    fs.closeSync(stderr);
  }
  writeJson(root, `preparation/${label}.json`, {
    command,
    args,
    cwd,
    beganAt,
    endedAt: new Date().toISOString(),
    status: result.status,
    signal: result.signal,
    error: result.error?.message,
  });
  assert.ok(
    !result.error && result.status === 0 && result.signal === null,
    `${label} failed; inspect preparation/${label}.stderr.txt and preserve the frozen pins`,
  );
  return fs.readFileSync(path.join(directory, `${label}.stdout.txt`), 'utf8').trim();
}

function dependencyProvenance(source) {
  const require = createRequire(path.join(source, 'package.json'));
  const lock = JSON.parse(fs.readFileSync(path.join(source, 'package-lock.json'), 'utf8'));
  return [
    'onnxruntime-node',
    '@huggingface/transformers',
    'better-sqlite3',
    'sqlite-vec',
    'js-tiktoken',
    'typescript',
  ].map((name) => {
    const entry = fs.realpathSync(require.resolve(name));
    let directory = path.dirname(entry);
    for (;;) {
      const packageFile = path.join(directory, 'package.json');
      if (fs.existsSync(packageFile)) {
        const info = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
        if (info.name === name) {
          assert.equal(
            info.version,
            lock.packages[`node_modules/${name}`].version,
            `Installed dependency differs from the lock: ${name}`,
          );
          return { name, version: info.version, entry, packageFile };
        }
      }
      const parent = path.dirname(directory);
      assert.notEqual(parent, directory, `Cannot locate installed package metadata: ${name}`);
      directory = parent;
    }
  });
}

async function prepare(root, bundle, workspace) {
  assert.equal(process.version, 'v26.12.0', 'Preparation requires exactly Node 26.12.0');
  assert.equal(process.platform, 'darwin', 'This frozen collector requires macOS');
  assert.equal(process.arch, 'arm64', 'This comparison requires an ARM64 runner');
  const fixtureRoot = path.join(bundle, 'fixtures/performance-audit');
  const inputs = readFrozenInputs(fixtureRoot);
  const bundleManifest = JSON.parse(
    fs.readFileSync(path.join(fixtureRoot, 'bundle-manifest.json'), 'utf8'),
  );
  verifyEntries(bundle, bundleManifest.files, 'bundle');
  const npmVersion = run(root, 'npm-version', 'npm', ['--version'], workspace);
  assert.equal(npmVersion, '12.2.0', 'Preparation requires exactly npm 12.2.0');
  const provenance = {
    phase: 'preparing',
    startedAt: new Date().toISOString(),
    node: process.version,
    npm: npmVersion,
    platform: process.platform,
    arch: process.arch,
    cpuCount: os.cpus().length,
    cpuModels: [...new Set(os.cpus().map((cpu) => cpu.model))],
    totalMemory: os.totalmem(),
    runner: Object.fromEntries(
      [
        'ImageOS',
        'ImageVersion',
        'RUNNER_OS',
        'RUNNER_ARCH',
        'GITHUB_RUN_ID',
        'GITHUB_RUN_ATTEMPT',
        'GITHUB_SHA',
      ].map((key) => [key, process.env[key] ?? null]),
    ),
    bundleManifestSha256: sha256(fs.readFileSync(path.join(fixtureRoot, 'bundle-manifest.json'))),
    sources: {},
  };
  writeJson(root, 'preparation/provenance.json', provenance);
  for (const name of [
    'measure-initial-quiet-migration.mjs',
    'harness-safe-cleanup.mjs',
    'telemetry.mjs',
    'prepare.mjs',
  ]) {
    fs.copyFileSync(
      path.join(bundle, 'scripts/performance-audit', name),
      path.join(root, name),
      fs.constants.COPYFILE_EXCL,
    );
  }
  for (const name of [
    ...Object.keys(inputHashes),
    'quiet-initial-protocol.md',
    'bundle-manifest.json',
  ]) {
    fs.copyFileSync(
      path.join(fixtureRoot, name),
      path.join(root, name),
      fs.constants.COPYFILE_EXCL,
    );
  }
  fs.mkdirSync(path.join(root, 'harness-archives'));
  for (const [label, pin] of Object.entries(revisions)) {
    const source = safePath(workspace, `sources/${label}`);
    const commit = run(root, `${label}-source`, 'git', ['rev-parse', 'HEAD'], source);
    assert.equal(commit, pin.commit, `${label}: source checkout differs from the frozen commit`);
    verifyEntries(source, [{ path: 'package-lock.json', sha256: pin.lock }], `${label} source`);
    run(root, `${label}-ci`, 'npm', ['ci'], source);
    run(root, `${label}-build`, 'npm', ['run', 'build'], source);
    const runtime = path.join(root, 'runtime', label);
    fs.mkdirSync(runtime, { recursive: true });
    run(root, `${label}-pack`, 'npm', ['pack', '--pack-destination', runtime], source);
    normalizePackage(root, label, pin.package);
    verifyEntries(runtime, [{ path: packageName, sha256: pin.package }], `${label} package`);
    run(
      root,
      `${label}-unpack`,
      'tar',
      ['-xzf', path.join(runtime, packageName), '--strip-components=1', '-C', runtime],
      root,
    );
    fs.copyFileSync(
      path.join(source, 'package-lock.json'),
      path.join(runtime, 'package-lock.json'),
    );
    fs.symlinkSync(path.join(source, 'node_modules'), path.join(runtime, 'node_modules'), 'dir');
    const runtimeFiles = verifyRuntime(runtime, inputs.runtime.runtime[label]);
    const dependencies = dependencyProvenance(source);
    run(root, `${label}-source-unchanged`, 'git', ['diff', '--exit-code', 'HEAD'], source);
    provenance.sources[label] = { commit, runtimeFiles, dependencies };
    writeJson(root, 'preparation/provenance.json', provenance);
  }
  fs.symlinkSync(
    path.join(workspace, 'sources/candidate/node_modules'),
    path.join(root, 'node_modules'),
    'dir',
  );
  const candidateSource = path.join(workspace, 'sources/candidate');
  const downloaded = path.join(candidateSource, 'fixtures/performance-audit-download');
  assert.ok(!fs.existsSync(downloaded), 'Refusing to reuse a previously downloaded corpus');
  run(
    root,
    'evergreen-download',
    'npm',
    [
      'run',
      'eval:prepare-evergreen-notes',
      '--',
      '--vault',
      'fixtures/performance-audit-download',
      '--no-images',
    ],
    candidateSource,
  );
  const corpus = path.join(root, 'corpus');
  inventory(downloaded); // Reject symlinks before copying the downloaded tree.
  fs.cpSync(downloaded, corpus, { recursive: true, errorOnExist: true, force: false });
  materializeSyntheticNotes(corpus, inputs.acceptance);
  provenance.corpus = verifyCorpus(corpus, inputs.corpus);
  writeJson(root, 'preparation/provenance.json', provenance);
  const cache = path.join(os.homedir(), '.cache/huggingface');
  const cached = verifyModelCache(cache, inputs.models, { allowMissing: true });
  if (cached.missing.length) {
    const vault = path.join(root, 'prefetch-vault');
    fs.mkdirSync(vault);
    fs.writeFileSync(
      path.join(vault, 'prefetch.md'),
      '# Model preparation\n\nOne temporary note loads the actual pinned E5 model before measurement.\n',
    );
    const harness = await import(pathToFileURL(path.join(root, 'harness-safe-cleanup.mjs')).href);
    let cleanup;
    try {
      await harness.cli('candidate', vault, ['reindex']);
    } finally {
      cleanup = await harness.stopAll();
      writeJson(root, 'preparation/prefetch-cleanup.json', {
        cleanup,
        closures: harness.closureEvidence(),
      });
      fs.rmSync(vault, { recursive: true });
    }
  }
  provenance.models = verifyModelCache(cache, inputs.models);
  // Recheck inputs after network/build activity, before the collector can begin.
  provenance.corpus = verifyCorpus(corpus, inputs.corpus);
  for (const label of Object.keys(revisions))
    verifyRuntime(path.join(root, 'runtime', label), inputs.runtime.runtime[label]);
  provenance.phase = 'ready';
  provenance.completedAt = new Date().toISOString();
  writeJson(root, 'preparation/provenance.json', provenance);
}

async function main() {
  assert.ok(
    process.env.RUNNER_TEMP,
    'RUNNER_TEMP is required; preparation is only for the isolated runner',
  );
  const root = path.join(fs.realpathSync(process.env.RUNNER_TEMP), 'initial-index-performance');
  const command = process.argv[2];
  assert.equal(process.argv.length, 3, 'Expected one command: prepare or archive');
  if (command === 'archive') {
    archiveEvidence(root, `${root}-artifact`);
    return;
  }
  assert.equal(command, 'prepare', 'Expected prepare or archive');
  assert.ok(!fs.existsSync(root), 'Refusing to overwrite a previous audit root');
  fs.mkdirSync(root);
  try {
    assert.ok(process.env.GITHUB_WORKSPACE, 'GITHUB_WORKSPACE is required');
    await prepare(
      root,
      fileURLToPath(new URL('../../', import.meta.url)),
      fs.realpathSync(process.env.GITHUB_WORKSPACE),
    );
    writeJson(root, 'preparation/prepare-status.json', { status: 'ready' });
  } catch (error) {
    writeJson(root, 'preparation/prepare-status.json', {
      status: 'failed',
      message: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
