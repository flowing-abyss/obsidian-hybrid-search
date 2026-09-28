import Database from 'better-sqlite3';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sqliteVec from 'sqlite-vec';
import { afterEach, beforeEach, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = process.env.OHS_INTEGRITY_CLI ?? path.join(ROOT, 'dist/src/cli.js');
const LEGACY_CLI = process.env.OHS_INTEGRITY_LEGACY_CLI ?? CLI;
let vault: string;
let endpoint: string;
let unavailable = false;
let bDim = 8;
let requests: Array<{ model: string; input: string[] }> = [];
let server: ReturnType<typeof createServer>;

beforeEach(async () => {
  vault = mkdtempSync(path.join(tmpdir(), 'ohs-integrity-process-'));
  unavailable = false;
  bDim = 8;
  requests = [];
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      response.setHeader('content-type', 'application/json');
      if (!request.url?.endsWith('/embeddings')) {
        response.end(JSON.stringify({ data: [] }));
        return;
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        model: string;
        input: string | string[];
      };
      const input = Array.isArray(payload.input) ? payload.input : [payload.input];
      requests.push({ model: payload.model, input });
      if (unavailable) {
        // A permanent rejection avoids backoff sleeps while exercising failed readiness.
        response.statusCode = 400;
        response.end(JSON.stringify({ error: { message: 'synthetic provider unavailable' } }));
        return;
      }
      const dim = payload.model === 'model-A' ? 4 : bDim;
      response.end(
        JSON.stringify({
          data: input.map((_, index) => ({
            index,
            object: 'embedding',
            embedding: Array.from({ length: dim }, (_, i) => (i === 0 ? 1 : 0)),
          })),
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  endpoint = `http://127.0.0.1:${address.port}/v1`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  rmSync(vault, { recursive: true, force: true });
});

function cleanProviderEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(OPENAI_|LOCAL_EMBEDDING_|OBSIDIAN_)/.test(key)) delete env[key];
  }
  return env;
}

function runCli(
  args: string[],
  model: string,
  executable = CLI,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = {
    ...cleanProviderEnv(),
    OBSIDIAN_VAULT_PATH: vault,
    OPENAI_API_KEY: 'synthetic-loopback-key',
    OPENAI_BASE_URL: endpoint,
    OPENAI_EMBEDDING_MODEL: model,
  };
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [executable, ...args],
      { cwd: vault, env, encoding: 'utf8', timeout: 20_000 },
      (error, stdout, stderr) =>
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout,
          stderr,
        }),
    );
  });
}

interface Snapshot {
  rows: Record<string, unknown[]>;
  vectors: unknown[];
  model: { value: string } | undefined;
  dimension: { value: string } | undefined;
  version: { value: string } | undefined;
  oldFts: unknown[];
}

function snapshot(): Snapshot {
  const db = new Database(path.join(vault, '.obsidian-hybrid-search.db'), { readonly: true });
  sqliteVec.load(db);
  try {
    const tables = [
      'notes',
      'chunks',
      'note_aliases',
      'note_tags',
      'note_frontmatter_fields',
      'links',
      'markdown_links',
      'note_urls',
      'event_log',
    ];
    return {
      rows: Object.fromEntries(
        tables.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
      ),
      vectors: db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'vec_chunks'").get()
        ? db
            .prepare('SELECT chunk_id, hex(embedding) AS bytes FROM vec_chunks ORDER BY chunk_id')
            .all()
        : [],
      model: db.prepare("SELECT value FROM settings WHERE key = 'embedding_model'").get() as
        { value: string } | undefined,
      dimension: db.prepare("SELECT value FROM settings WHERE key = 'embedding_dim'").get() as
        { value: string } | undefined,
      version: db.prepare("SELECT value FROM settings WHERE key = 'db_version'").get() as
        { value: string } | undefined,
      oldFts: db
        .prepare("SELECT rowid FROM notes_fts_bm25 WHERE notes_fts_bm25 MATCH 'Original'")
        .all(),
    };
  } finally {
    db.close();
  }
}

function writeBody(text: string, time: number, name = 'note.md'): void {
  const file = path.join(vault, name);
  writeFileSync(file, `# Integrity\n\n${text}\n`);
  utimesSync(file, time, time);
}

async function seedA(): Promise<void> {
  writeBody(
    'Original searchable content retained until a successful compatible update.',
    1_700_000_001,
  );
  const seeded = await runCli(['reindex'], 'model-A', LEGACY_CLI);
  assert.equal(seeded.code, 0, seeded.stderr);
  assert.deepEqual(snapshot().model, { value: 'model-A' });
  assert.ok(snapshot().vectors.length > 0);
}

it.each([4, 8])(
  'ordinary model drift with B dimension %i preserves A and permits ordinary retry',
  async (dimension) => {
    bDim = dimension;
    await seedA();
    const before = snapshot();
    writeBody(
      'Replacement searchable content becomes indexed after restoring the model.',
      1_700_000_002,
    );
    const rejected = await runCli(['reindex'], 'model-B');
    assert.deepEqual(snapshot(), before);
    assert.match(rejected.stderr, /model.*mismatch/i);
    const retry = await runCli(['reindex'], 'model-A');
    assert.equal(retry.code, 0, retry.stderr);
    assert.match(retry.stderr, /1 indexed/);
    assert.notDeepEqual(snapshot().rows.notes, before.rows.notes);
    const repeated = await runCli(['reindex'], 'model-A');
    assert.equal(repeated.code, 0, repeated.stderr);
    assert.match(repeated.stderr, /1 skipped/);
  },
);

it.each([4, 8])('full force replaces A with freshly probed B dimension %i', async (dimension) => {
  bDim = dimension;
  await seedA();
  requests = [];
  const result = await runCli(['reindex', '--force'], 'model-B');
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(snapshot().model, { value: 'model-B' });
  assert.deepEqual(snapshot().dimension, { value: String(dimension) });
  assert.ok(
    requests.some(
      (request) =>
        request.model === 'model-B' &&
        request.input.some((input) => input.includes('dimension probe')),
    ),
  );
  assert.ok(snapshot().vectors.length > 0);
});

it('failed force readiness preserves the old usable DB', async () => {
  await seedA();
  const before = snapshot();
  unavailable = true;
  const result = await runCli(['reindex', '--force'], 'model-B');
  assert.deepEqual(snapshot(), before);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /probe|embedding|provider/i);
});

it('path force is a note retry and cannot replace the model', async () => {
  await seedA();
  const before = snapshot();
  const result = await runCli(['reindex', 'note.md', '--force'], 'model-B');
  assert.deepEqual(snapshot(), before);
  assert.match(result.stdout + result.stderr, /model.*mismatch/i);
});

it.each([false, true])(
  '--errors with force=%s preserves A when an actual failed note is retried under B',
  async (force) => {
    await seedA();
    writeBody('This note has a failed embedding to retry.', 1_700_000_003, 'repair.md');
    unavailable = true;
    const failed = await runCli(['reindex', 'repair.md'], 'model-A');
    assert.equal(failed.code, 0, failed.stderr);
    unavailable = false;
    const before = snapshot();
    assert.equal(
      (before.rows.chunks as Array<{ embedding_status: string }>).filter(
        (chunk) => chunk.embedding_status === 'failed',
      ).length,
      1,
    );
    const result = await runCli(['reindex', '--errors', ...(force ? ['--force'] : [])], 'model-B');
    assert.deepEqual(snapshot(), before);
    assert.match(result.stderr, /model.*mismatch/i);
  },
);

it('ordinary fresh reindex retains provider-failure behavior without implicit force', async () => {
  writeBody('First note is waiting for an embedding provider to become available.', 1_700_000_001);
  unavailable = true;
  const result = await runCli(['reindex'], 'model-A');
  assert.equal(result.code, 0, result.stderr);
  const db = new Database(path.join(vault, '.obsidian-hybrid-search.db'), { readonly: true });
  try {
    assert.equal(
      db.prepare("SELECT value FROM settings WHERE key='embedding_model'").get(),
      undefined,
    );
  } finally {
    db.close();
  }
});

it('an already-open writer reads a changed model marker inside its write transaction', async () => {
  await seedA();
  const script = `
    import { openDb, closeDb, upsertNote } from ${JSON.stringify(path.join(ROOT, 'dist/src/db.js'))};
    openDb();
    process.send({ kind: 'ready' });
    process.on('message', (message) => {
      if (message !== 'write') return;
      try {
        upsertNote({ path: 'race.md', title: 'Race', tags: [], content: 'race', mtime: 1,
          hash: 'race-hash', chunks: [{ text: 'race', embedding: new Float32Array([1, 0, 0, 0]) }] },
          { modelName: 'model-A' });
        process.send({ kind: 'written' });
      } catch (error) {
        process.send({ kind: 'rejected', error: String(error) });
      } finally { closeDb(); process.disconnect(); }
    });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: vault,
    env: { ...cleanProviderEnv(), OBSIDIAN_VAULT_PATH: vault },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`Writer exited before ready: ${code}`)));
      child.once('message', (message: { kind: string }) => {
        if (message.kind === 'ready') resolve();
        else reject(new Error(`Writer did not open: ${JSON.stringify(message)}`));
      });
    });
    const db = new Database(path.join(vault, '.obsidian-hybrid-search.db'));
    try {
      db.prepare("UPDATE settings SET value='model-B' WHERE key='embedding_model'").run();
    } finally {
      db.close();
    }
    const before = snapshot();
    const result = await new Promise<{ kind: string; error?: string }>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`Writer exited before reply: ${code}`)));
      child.once('message', resolve);
      child.send('write');
    });
    assert.equal(result.kind, 'rejected', JSON.stringify(result));
    assert.match(result.error ?? '', /model.*mismatch/i);
    assert.deepEqual(snapshot(), before);
  } finally {
    child.kill();
  }
});
