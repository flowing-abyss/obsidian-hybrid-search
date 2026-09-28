import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(root, 'dist/src/cli.js');
const preload = new URL('../dist/test/fixtures/cpu-threads-preload.js', import.meta.url).href;
let temp: string;
let vault: string;
let cache: string;
let log: string;

beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ohs-cli-cpu-'));
  vault = path.join(temp, 'vault');
  cache = path.join(temp, 'cache');
  log = path.join(temp, 'model.jsonl');
  fs.mkdirSync(vault);
  fs.writeFileSync(path.join(vault, 'note.md'), '# Note\nTesting CPU preferences.');
});
afterEach(() => fs.rmSync(temp, { recursive: true, force: true }));

function run(args: string[]) {
  return spawnSync(process.execPath, ['--import', preload, cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      ...process.env,
      OBSIDIAN_VAULT_PATH: vault,
      XDG_CACHE_HOME: cache,
      OHS_TEST_THREAD_LOG: log,
      OPENAI_API_KEY: '',
      OPENAI_BASE_URL: '',
      OPENAI_EMBEDDING_MODEL: '',
      LOCAL_EMBEDDING_MODEL: 'Xenova/multilingual-e5-small',
    },
  });
}

function preference(): string {
  return path.join(cache, 'obsidian-hybrid-search', 'inference-settings.json');
}

it('saves before model dimension probing and reuses the value in a fresh process', () => {
  const first = run(['reindex', '--threads', '4', 'note.md']);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(preference(), 'utf8')), { version: 1, threads: 4 });
  const second = run(['reindex', '--force', 'note.md']);
  assert.equal(second.status, 0, second.stderr);
  const entries = fs
    .readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as unknown);
  assert.deepEqual(entries, [
    { persisted: { version: 1, threads: 4 }, session: { intraOpNumThreads: 4 } },
    { persisted: { version: 1, threads: 4 }, session: { intraOpNumThreads: 4 } },
  ]);
});

it.each(['-1', '1.5', 'abc', '2147483648'])(
  'rejects invalid --threads %s before initialization',
  (value) => {
    const result = run(['reindex', '--threads', value]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid --threads/);
    assert.equal(fs.existsSync(preference()), false);
    assert.equal(fs.existsSync(path.join(vault, '.obsidian-hybrid-search.db')), false);
  },
);

it('rejects errors with a path before persisting', () => {
  const result = run(['reindex', '--errors', '--threads', '3', 'note.md']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /takes no path/);
  assert.equal(fs.existsSync(preference()), false);
});

it('saves zero as native auto without a session override', () => {
  const result = run(['reindex', '--threads', '0', 'note.md']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(preference(), 'utf8')), { version: 1, threads: 0 });
  const entry = JSON.parse(fs.readFileSync(log, 'utf8').trim()) as { session: unknown };
  assert.equal(entry.session, null);
});

it('allows the preference with failed-note repair', () => {
  const result = run(['reindex', '--errors', '--threads', '3']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(preference(), 'utf8')), { version: 1, threads: 3 });
});

it('fails on explicit persistence error before indexing', () => {
  fs.writeFileSync(cache, 'blocked');
  const result = run(['reindex', '--threads', '2']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Error:|ENOTDIR|EEXIST/);
  assert.equal(fs.existsSync(path.join(vault, '.obsidian-hybrid-search.db')), false);
});

it.each([
  ['search', 'note'],
  ['mcp', undefined],
])('keeps %s from exposing a thread setter', (command, operand) => {
  const result = run([command, '--threads', '3', ...(operand ? [operand] : [])]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown option/);
  assert.equal(fs.existsSync(preference()), false);
});

it('documents saved local CPU scope, zero and restart in reindex help', () => {
  const result = run(['reindex', '--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--threads <count>/);
  assert.match(result.stdout, /local CPU/i);
  assert.match(result.stdout, /zero|0 =|0 for/i);
  assert.match(result.stdout, /restart/i);
});
