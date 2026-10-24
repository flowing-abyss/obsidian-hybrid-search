import Database from 'better-sqlite3';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as sqliteVec from 'sqlite-vec';
import { afterEach, beforeEach, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'dist/src/cli.js');
const dbModule = pathToFileURL(path.join(root, 'dist/src/storage/db.js')).href;
const serviceModule = pathToFileURL(path.join(root, 'dist/src/indexing/index-service.js')).href;
let vault: string;
let endpoint: string;
let requests: string[][];
let provider: ReturnType<typeof createServer>;
let children: Array<{ child: ChildProcess; closed: Promise<void> }>;
let holdDocuments = false;
let held: Array<() => void>;

beforeEach(async () => {
  vault = mkdtempSync(path.join(tmpdir(), 'ohs-owner-process-'));
  children = [];
  requests = [];
  held = [];
  holdDocuments = false;
  provider = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (!req.url?.endsWith('/embeddings')) {
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      const { input } = JSON.parse(Buffer.concat(chunks).toString()) as { input: string[] };
      requests.push(input);
      const reply = () =>
        res.end(
          JSON.stringify({
            data: input.map((_text, index) => ({ index, embedding: [1, 0, 0, 0] })),
          }),
        );
      if (holdDocuments && !input.some((text) => text.includes('dimension probe')))
        held.push(reply);
      else reply();
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address();
  assert.ok(address && typeof address === 'object');
  endpoint = `http://127.0.0.1:${address.port}/v1`;
});

afterEach(async () => {
  held.forEach((reply) => reply());
  await Promise.all(
    children.map(async ({ child, closed }) => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGCONT');
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const kill = setTimeout(() => child.kill('SIGKILL'), 1000);
      try {
        await closed;
      } finally {
        clearTimeout(kill);
      }
    }),
  );
  provider.closeAllConnections();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  rmSync(vault, { recursive: true, force: true });
});

function env(): NodeJS.ProcessEnv {
  const result = { ...process.env };
  for (const key of Object.keys(result))
    if (/^(OBSIDIAN_|OPENAI_|LOCAL_EMBEDDING_)/.test(key)) delete result[key];
  return {
    ...result,
    OBSIDIAN_VAULT_PATH: vault,
    OPENAI_BASE_URL: endpoint,
    OPENAI_API_KEY: 'loopback-test',
    OPENAI_EMBEDDING_MODEL: 'owner-test',
    OBSIDIAN_DEBOUNCE_MS: '20',
  };
}
function launch(args: string[]) {
  const child = spawn(process.execPath, args, {
    cwd: vault,
    env: env(),
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr!.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  children.push({ child, closed });
  return { child, closed, stdout: () => stdout, stderr: () => stderr };
}
async function runCli(args: string[]) {
  const process = launch([cli, ...args]);
  await process.closed;
  return { code: process.child.exitCode, stdout: process.stdout(), stderr: process.stderr() };
}
async function waitUntil(predicate: () => boolean, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for process state');
    await delay(25);
  }
}
function inspect<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(path.join(vault, '.obsidian-hybrid-search.db'));
  sqliteVec.load(db);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
function owner(): { token: string | null; mode: string; heartbeat_sequence: number } {
  return inspect((db) =>
    db.prepare('SELECT token,mode,heartbeat_sequence FROM index_owner').get(),
  ) as ReturnType<typeof owner>;
}
async function seed(): Promise<void> {
  writeFileSync(path.join(vault, 'café.md'), '# Original\n\nOriginal searchable content.');
  const result = await runCli(['reindex']);
  assert.equal(result.code, 0, result.stderr);
}
function script(source: string) {
  return launch(['--input-type=module', '-e', source]);
}
async function firstMessage(process: ReturnType<typeof launch>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`No worker response: ${process.stderr()}`)),
      10_000,
    );
    process.child.once('message', (message) => {
      clearTimeout(timer);
      resolve(message as Record<string, unknown>);
    });
    process.child.once('error', reject);
  });
}

it('serializes eight simultaneous schema openings and background claims', async () => {
  const workers = Array.from({ length: 8 }, () =>
    script(`
    import { openIndexDatabase } from ${JSON.stringify(serviceModule)};
    import { claimIndexLease, releaseIndexLease, closeDb } from ${JSON.stringify(dbModule)};
    import { randomUUID } from 'node:crypto';
    await openIndexDatabase(); const lease=claimIndexLease(randomUUID(),'background');
    process.on('message',()=>{});process.send({won:!!lease});
    process.on('SIGTERM',()=>{if(lease)releaseIndexLease(lease);closeDb();process.exit(0)});
  `),
  );
  const results = await Promise.all(workers.map(firstMessage));
  assert.equal(results.filter((result) => result.won).length, 1);
  assert.equal(requests.length, 0);
  assert.equal(
    inspect((db) => db.prepare('PRAGMA integrity_check').pluck().get()),
    'ok',
  );
});

async function mcp() {
  const process = launch([cli, 'mcp']);
  let sequence = 0;
  const pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  createInterface({ input: process.child.stdout! }).on('line', (line) => {
    const value = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
    if (value.id === undefined) return;
    const wait = pending.get(value.id);
    if (!wait) return;
    clearTimeout(wait.timer);
    pending.delete(value.id);
    if (value.error) wait.reject(new Error(JSON.stringify(value.error)));
    else wait.resolve(value.result);
  });
  const call = (method: string, params: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP timeout ${process.stderr()}`));
      }, 10_000);
      pending.set(id, { resolve, reject, timer });
      process.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  await call('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'owner-test', version: '1' },
  });
  process.child.stdin!.write(
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
  );
  return { ...process, call };
}

it('five MCP servers and CLI readers share one indexing pass and remain idle afterwards', async () => {
  await seed();
  requests = [];
  const source = path.join(vault, 'café.md');
  const hash = createHash('sha256').update(readFileSync(source)).digest('hex');
  const servers = await Promise.all(Array.from({ length: 5 }, () => mcp()));
  await waitUntil(() => owner().token !== null);
  writeFileSync(path.join(vault, 'second.md'), '# Second\n\nUnique parallel content.');
  await waitUntil(
    () =>
      inspect((db) =>
        Number(db.prepare("SELECT count(*) FROM notes WHERE path='second.md'").pluck().get()),
      ) === 1,
  );
  const reads = await Promise.all(
    Array.from({ length: 4 }, () => runCli(['search', 'Original', '--mode', 'fulltext', '--json'])),
  );
  for (const result of reads) {
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /café/);
  }
  const status = await Promise.all(
    servers.map((server) => server.call('tools/call', { name: 'status', arguments: {} })),
  );
  assert.ok(status.every((result) => JSON.stringify(result).includes('failed_indexing')));
  assert.equal(
    requests.filter((input) => input.some((text) => text.includes('Unique parallel content')))
      .length,
    1,
  );
  const count = requests.length;
  await delay(5500);
  assert.equal(requests.length, count);
  assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'), hash);
  assert.equal(
    inspect((db) => db.prepare('PRAGMA integrity_check').pluck().get()),
    'ok',
  );
  assert.equal(
    inspect((db) =>
      db
        .prepare(
          'SELECT count(*) FROM vec_chunks v LEFT JOIN chunks c ON c.id=v.chunk_id WHERE c.id IS NULL',
        )
        .pluck()
        .get(),
    ),
    0,
  );
});

it('a foreground rebuild preempts a paused background computation and stale work cannot publish', async () => {
  await seed();
  const worker = script(`
    import { openIndexDatabase, createIndexService } from ${JSON.stringify(serviceModule)};
    import { closeDb } from ${JSON.stringify(dbModule)};
    await openIndexDatabase();const service=createIndexService(); service.start();
    process.on('message',()=>{});process.send({ready:true}); process.on('SIGTERM',()=>{void service.close().finally(()=>{closeDb();process.exit(0)})});
  `);
  await firstMessage(worker);
  await waitUntil(() => owner().mode === 'background');
  const oldToken = owner().token;
  holdDocuments = true;
  writeFileSync(path.join(vault, 'blocked.md'), 'Old pending content');
  await waitUntil(() => held.length > 0);
  if (process.platform !== 'win32') worker.child.kill('SIGSTOP');
  writeFileSync(path.join(vault, 'blocked.md'), 'Current replacement content');
  holdDocuments = false;
  const inode = statSync(path.join(vault, '.obsidian-hybrid-search.db')).ino;
  const rebuilt = await runCli(['reindex', '--force']);
  assert.equal(rebuilt.code, 0, rebuilt.stderr);
  assert.notEqual(owner().token, oldToken);
  held.splice(0).forEach((reply) => reply());
  if (process.platform !== 'win32') worker.child.kill('SIGCONT');
  await delay(750);
  const body = inspect((db) =>
    db.prepare("SELECT content FROM notes WHERE path='blocked.md'").pluck().get(),
  );
  assert.equal(body, 'Current replacement content');
  assert.equal(statSync(path.join(vault, '.obsidian-hybrid-search.db')).ino, inode);
  assert.equal(
    inspect((db) => db.prepare('PRAGMA integrity_check').pluck().get()),
    'ok',
  );
});

it('a follower takes over after SIGKILL without manual cleanup', async () => {
  await seed();
  const makeWorker = () =>
    script(`
    import { openIndexDatabase, createIndexService } from ${JSON.stringify(serviceModule)};
    import { closeDb } from ${JSON.stringify(dbModule)};
    await openIndexDatabase();const service=createIndexService();service.start();process.on('message',()=>{});process.send({ready:true});
    process.on('SIGTERM',()=>{void service.close().finally(()=>{closeDb();process.exit(0)})});
  `);
  const first = makeWorker();
  await firstMessage(first);
  await waitUntil(() => owner().token !== null);
  const token = owner().token;
  const follower = makeWorker();
  await firstMessage(follower);
  first.child.kill('SIGKILL');
  await first.closed;
  writeFileSync(path.join(vault, 'after-death.md'), 'Automatic recovery after owner death');
  await waitUntil(() => owner().token !== null && owner().token !== token, 40_000);
  await waitUntil(
    () =>
      inspect((db) =>
        Number(db.prepare("SELECT count(*) FROM notes WHERE path='after-death.md'").pluck().get()),
      ) === 1,
  );
  assert.equal(
    requests.filter((input) => input.some((text) => text.includes('Automatic recovery'))).length,
    1,
  );
}, 60_000);
