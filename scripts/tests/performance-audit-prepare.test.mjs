/* global structuredClone */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import {
  archiveEvidence,
  materializeSyntheticNotes,
  readFrozenInputs,
  validateProvenance,
  verifyCorpus,
  verifyModelCache,
  verifyRuntime,
} from '../performance-audit/prepare.mjs';

const fixtureRoot = fileURLToPath(new URL('../../fixtures/performance-audit/', import.meta.url));
const abcHash = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const emptyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

test('workflow bounds setup while reserving the complete collection and evidence budgets', () => {
  const file = new URL('../../.github/workflows/initial-index-performance.yml', import.meta.url);
  const workflow = YAML.parse(fs.readFileSync(file, 'utf8'));
  const job = workflow.jobs.measure;
  let maximumStepMinutes = 0;
  for (const step of job.steps) {
    const minutes = step['timeout-minutes'];
    assert.ok(
      Number.isInteger(minutes) && minutes > 0,
      `Unbounded workflow step: ${step.name ?? step.uses}`,
    );
    maximumStepMinutes += minutes;
  }
  const collector = job.steps.find((step) => step.id === 'collect');
  const archive = job.steps.find((step) => step.id === 'archive');
  const upload = job.steps.find((step) => step.id === 'upload');
  assert.equal(
    collector?.['timeout-minutes'],
    47,
    'Preserve all 45 collection minutes plus the existing stop grace',
  );
  assert.ok(
    archive?.['timeout-minutes'] >= 2,
    'Reserve evidence staging after a failed or pending collection',
  );
  assert.ok(
    upload?.['timeout-minutes'] >= 5,
    'Reserve artifact upload after a failed or pending collection',
  );
  assert.equal(archive.if, 'always()');
  assert.equal(upload.if, 'always()');
  assert.ok(job.steps.indexOf(collector) < job.steps.indexOf(archive));
  assert.ok(job.steps.indexOf(archive) < job.steps.indexOf(upload));
  assert.ok(
    maximumStepMinutes + 3 <= job['timeout-minutes'],
    `Step limits consume ${maximumStepMinutes} minutes; the job must also retain the three-minute initialization margin`,
  );
});

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ohs-performance-prepare-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, name, contents) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

function manifest(files = [{ path: 'notes/a.md', bytes: 3, sha256: abcHash }]) {
  return { files };
}

test('corpus verification detects edited, missing, and unexpected notes', (t) => {
  const root = temporary(t);
  const note = write(root, 'notes/a.md', 'abc');
  assert.deepEqual(verifyCorpus(root, manifest()), { files: 1, bytes: 3 });
  fs.writeFileSync(note, 'abd');
  assert.throws(() => verifyCorpus(root, manifest()), /corpus.*hash|hash.*corpus/i);
  fs.unlinkSync(note);
  assert.throws(() => verifyCorpus(root, manifest()), /corpus.*missing|missing.*corpus/i);
  fs.writeFileSync(note, 'abc');
  write(root, 'notes/unjudged.md', 'abc');
  assert.throws(() => verifyCorpus(root, manifest()), /corpus.*unexpected|unexpected.*corpus/i);
});

test('synthetic notes retain authored bytes, empty notes, and decomposed paths', (t) => {
  const root = temporary(t);
  const notes = [
    { path: 'Acceptance/Cafe\u0301.md', content: 'abc' },
    { path: 'Acceptance/empty.md', content: '' },
  ];
  materializeSyntheticNotes(root, { notes });
  assert.equal(fs.readFileSync(path.join(root, notes[0].path), 'utf8'), 'abc');
  assert.ok(fs.readdirSync(path.join(root, 'Acceptance')).includes('Cafe\u0301.md'));
  assert.deepEqual(
    verifyCorpus(
      root,
      manifest([
        { path: notes[0].path, bytes: 3, sha256: abcHash },
        { path: notes[1].path, bytes: 0, sha256: emptyHash },
      ]),
    ),
    { files: 2, bytes: 3 },
  );
  assert.throws(() => materializeSyntheticNotes(root, { notes }), /exist|overwrite/i);
});

test('untrusted note paths cannot escape the corpus or write through symlinks', (t) => {
  const root = temporary(t);
  const corpus = path.join(root, 'corpus');
  fs.mkdirSync(corpus);
  for (const notePath of [
    '../outside.md',
    '/outside.md',
    'notes/../../outside.md',
    'C:\\outside.md',
  ]) {
    assert.throws(
      () => materializeSyntheticNotes(corpus, { notes: [{ path: notePath, content: 'abc' }] }),
      /path/i,
    );
    assert.throws(
      () => verifyCorpus(corpus, manifest([{ path: notePath, bytes: 3, sha256: abcHash }])),
      /path/i,
    );
  }
  const outside = write(root, 'outside/untouched.md', 'abc');
  fs.symlinkSync(path.dirname(outside), path.join(corpus, 'linked'), 'dir');
  assert.throws(
    () => materializeSyntheticNotes(corpus, { notes: [{ path: 'linked/new.md', content: 'abc' }] }),
    /symbolic|symlink/i,
  );
  assert.throws(() => verifyCorpus(corpus, manifest()), /symbolic|symlink/i);
  assert.equal(fs.existsSync(path.join(root, 'outside.md')), false);
  assert.equal(fs.existsSync(path.join(root, 'outside/new.md')), false);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'abc');
});

test('malformed and canonically duplicate manifest paths fail before corpus admission', (t) => {
  const root = temporary(t);
  write(root, 'notes/a.md', 'abc');
  for (const bad of [
    null,
    {},
    { files: [] },
    manifest([{ path: 'notes/a.md', sha256: abcHash }]),
    manifest([{ path: 'notes/a.md', bytes: -1, sha256: abcHash }]),
    manifest([{ path: 'notes/a.md', bytes: 3, sha256: 'bad' }]),
  ]) {
    assert.throws(() => verifyCorpus(root, bad), /manifest|entry|hash|bytes/i);
  }
  assert.throws(
    () =>
      verifyCorpus(
        root,
        manifest([
          { path: 'notes/Caf\u00e9.md', bytes: 3, sha256: abcHash },
          { path: 'notes/Cafe\u0301.md', bytes: 3, sha256: abcHash },
        ]),
      ),
    /duplicate/i,
  );
});

test('a synthetic path error leaves every note unwritten', (t) => {
  const root = temporary(t);
  assert.throws(
    () =>
      materializeSyntheticNotes(root, {
        notes: [
          { path: 'Acceptance/good.md', content: 'abc' },
          { path: '../escape.md', content: 'abc' },
        ],
      }),
    /path/i,
  );
  assert.deepEqual(fs.readdirSync(root), []);
});

test('model verification permits prefetch only for absent files, never altered cache hits', (t) => {
  const root = temporary(t);
  const artifacts = {
    files: [
      'config.json',
      'tokenizer.json',
      'tokenizer_config.json',
      'onnx/model_quantized.onnx',
    ].map((file) => ({
      model: 'Xenova/multilingual-e5-small',
      file,
      bytes: 3,
      sha256: abcHash,
    })),
  };
  assert.equal(verifyModelCache(root, artifacts, { allowMissing: true }).missing.length, 4);
  assert.throws(() => verifyModelCache(root, artifacts), /model.*missing|missing.*model/i);
  for (const item of artifacts.files) write(root, `${item.model}/${item.file}`, 'abc');
  assert.equal(verifyModelCache(root, artifacts).files.length, 4);
  write(root, 'Xenova/multilingual-e5-small/config.json', 'abd');
  assert.throws(
    () => verifyModelCache(root, artifacts, { allowMissing: true }),
    /model.*hash|hash.*model/i,
  );
  assert.throws(() => verifyModelCache(root, { files: [] }), /model|manifest/i);
  const bad = structuredClone(artifacts);
  bad.files[0].file = '../../../escape';
  assert.throws(() => verifyModelCache(root, bad), /path|model/i);
});

test('model symlinks cannot replace a pinned cache artifact', (t) => {
  const root = temporary(t);
  const cache = path.join(root, 'cache');
  fs.mkdirSync(cache);
  const outside = write(root, 'outside.json', 'abc');
  const artifacts = {
    files: [
      'config.json',
      'tokenizer.json',
      'tokenizer_config.json',
      'onnx/model_quantized.onnx',
    ].map((file) => ({
      model: 'Xenova/multilingual-e5-small',
      file,
      bytes: 3,
      sha256: abcHash,
    })),
  };
  for (const item of artifacts.files) write(cache, `${item.model}/${item.file}`, 'abc');
  const target = path.join(cache, 'Xenova/multilingual-e5-small/config.json');
  fs.unlinkSync(target);
  fs.symlinkSync(outside, target);
  assert.throws(() => verifyModelCache(cache, artifacts), /symbolic|symlink/i);
});

test('frozen inputs reject malformed, missing, and altered provenance before preparation', (t) => {
  const root = temporary(t);
  fs.cpSync(fixtureRoot, root, { recursive: true });
  const inputs = readFrozenInputs(root);
  assert.equal(inputs.corpus.files.length, 1393);
  assert.equal(inputs.acceptance.notes.length, 36);
  assert.equal(inputs.queries.length, 110);
  const source = path.join(root, 'runtime-source-commit.json');
  fs.writeFileSync(source, '{');
  assert.throws(() => readFrozenInputs(root), /runtime-source-commit/i);
  fs.copyFileSync(path.join(fixtureRoot, 'runtime-source-commit.json'), source);
  const runtime = structuredClone(inputs.runtime);
  runtime.candidate_head = '8109080ae62abb60504cf14a118dd75a464cf9d3';
  assert.throws(() => validateProvenance(runtime, inputs.source), /candidate|provenance/i);
  assert.throws(
    () => validateProvenance(inputs.runtime, { ...inputs.source, packageSha256: abcHash }),
    /package|provenance/i,
  );
  fs.unlinkSync(source);
  assert.throws(() => readFrozenInputs(root), /runtime-source-commit/i);
  fs.copyFileSync(path.join(fixtureRoot, 'runtime-source-commit.json'), source);
  fs.appendFileSync(path.join(root, 'corpus-manifest.json'), '\n');
  assert.throws(() => readFrozenInputs(root), /corpus-manifest/i);
});

test('packed runtime verification detects a replaced tarball, lock, or compiled module', (t) => {
  const root = temporary(t);
  const names = [
    'package.json',
    'package-lock.json',
    'obsidian-hybrid-search-0.16.4.tgz',
    'dist/src/cli.js',
  ];
  for (const name of names) write(root, name, 'abc');
  const expected = {
    'package.json': abcHash,
    'package-lock.json': abcHash,
    'obsidian-hybrid-search-0.16.4.tgz': abcHash,
    compiled_files: { 'dist/src/cli.js': abcHash },
  };
  assert.equal(verifyRuntime(root, expected).compiledFiles, 1);
  for (const name of names) {
    write(root, name, 'abd');
    assert.throws(() => verifyRuntime(root, expected), /runtime.*hash|hash.*runtime/i);
    write(root, name, 'abc');
  }
  write(root, 'dist/src/unexpected.js', 'abc');
  assert.throws(() => verifyRuntime(root, expected), /runtime.*unexpected|unexpected.*runtime/i);
  assert.throws(
    () => verifyRuntime(root, { ...expected, compiled_files: { '../escape.js': abcHash } }),
    /path/i,
  );
});

test('fixture hashes describe the exact authored synthetic note bytes', () => {
  const inputs = readFrozenInputs(fixtureRoot);
  const expected = new Map(
    inputs.corpus.files.map((entry) => [entry.path.normalize('NFC'), entry]),
  );
  for (const note of inputs.acceptance.notes) {
    const item = expected.get(note.path.normalize('NFC'));
    assert.ok(item, note.path);
    assert.equal(Buffer.byteLength(note.content), item.bytes, note.path);
    assert.equal(createHash('sha256').update(note.content).digest('hex'), item.sha256, note.path);
  }
});

test('evidence staging preserves failed attempts and excludes corpus, databases, weights, and dependencies', (t) => {
  const root = temporary(t);
  const audit = path.join(root, 'audit');
  const destination = path.join(root, 'artifact');
  write(
    audit,
    'quiet-initial-measurements-1.json',
    '{"status":"pending","attempts":[{"accepted":false}]}',
  );
  write(audit, 'quiet-initial-host-1.jsonl', '{"rows":[]}\n');
  write(audit, 'cleanup-1.json', '{"errors":["example failure"]}');
  write(audit, 'runs/attempt-1/stderr.txt', 'failed input\n');
  write(audit, 'preparation/prepare-status.json', '{"status":"failed"}');
  for (const name of [
    'corpus/notes/a.md',
    'vaults/a/.obsidian-hybrid-search.db',
    'runtime/base/node_modules/private.js',
    'models/model.onnx',
  ]) {
    write(audit, name, 'DO NOT UPLOAD');
  }
  const report = archiveEvidence(audit, destination);
  assert.equal(
    fs.readFileSync(path.join(destination, 'runs/attempt-1/stderr.txt'), 'utf8'),
    'failed input\n',
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(destination, 'quiet-initial-measurements-1.json'))).status,
    'pending',
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(destination, 'cleanup-1.json'))).errors.length,
    1,
  );
  assert.equal(report.files.length, 5);
  for (const name of ['corpus', 'vaults', 'runtime', 'models'])
    assert.equal(fs.existsSync(path.join(destination, name)), false);
  const archived = JSON.parse(fs.readFileSync(path.join(destination, 'artifact-manifest.json')));
  assert.equal(archived.files.find((file) => file.path === 'runs/attempt-1/stderr.txt').bytes, 13);
});

test('evidence staging rejects symlinks without copying an external file', (t) => {
  const root = temporary(t);
  const audit = path.join(root, 'audit');
  const outside = write(root, 'outside.txt', 'private');
  fs.mkdirSync(path.join(audit, 'runs'), { recursive: true });
  fs.symlinkSync(outside, path.join(audit, 'runs/stdout.txt'));
  const destination = path.join(root, 'artifact');
  assert.throws(() => archiveEvidence(audit, destination), /symbolic|symlink/i);
  assert.equal(fs.existsSync(path.join(destination, 'runs/stdout.txt')), false);
});

test('evidence staging records preparation never starting without inventing a collected result', (t) => {
  const root = temporary(t);
  const destination = path.join(root, 'artifact');
  const result = archiveEvidence(path.join(root, 'absent'), destination);
  assert.equal(result.status, 'no-preparation-output');
  assert.deepEqual(result.files, []);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(destination, 'artifact-manifest.json'))).status,
    'no-preparation-output',
  );
});
