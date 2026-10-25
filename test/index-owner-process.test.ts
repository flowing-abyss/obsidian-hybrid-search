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
      if (process.platform !== 'win32' && child.exitCode === null && child.signalCode === null)
        child.kill('SIGCONT');
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
    process.on('message',()=>process.send({cpu:process.cpuUsage()}));process.send({won:!!lease});
    process.on('SIGTERM',()=>{if(lease)releaseIndexLease(lease);closeDb();process.exit(0)});
  `),
  );
  const results = await Promise.all(workers.map(firstMessage));
  assert.equal(results.filter((result) => result.won).length, 1);
  const sampleCpu = () =>
    Promise.all(
      workers.map((worker) => {
        const reply = firstMessage(worker);
        worker.child.send('cpu');
        return reply;
      }),
    );
  const beforeCpu = await sampleCpu();
  await delay(1500);
  const afterCpu = await sampleCpu();
  for (let index = 0; index < workers.length; index++) {
    const before = beforeCpu[index]!.cpu as { user: number; system: number };
    const after = afterCpu[index]!.cpu as { user: number; system: number };
    assert.ok(
      after.user + after.system - before.user - before.system < 200_000,
      'idle claimants must not spin',
    );
  }
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
  assert.deepEqual(
    inspect((db) => db.prepare('PRAGMA foreign_key_check').all()),
    [],
  );
  assert.equal(
    inspect((db) =>
      db
        .prepare(
          "SELECT count(*) FROM chunks c LEFT JOIN vec_chunks v ON v.chunk_id=c.id WHERE c.embedding_status='ok' AND v.chunk_id IS NULL",
        )
        .pluck()
        .get(),
    ),
    0,
  );
  assert.deepEqual(
    inspect((db) => db.prepare('SELECT path FROM notes ORDER BY path').pluck().all()),
    ['café.md'.normalize('NFD'), 'second.md'],
  );
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

it('preserves an unreadable main database and reports the error', async () => {
  const filename = path.join(vault, '.obsidian-hybrid-search.db');
  const bytes = Buffer.from('This is deliberately not a SQLite database.');
  writeFileSync(filename, bytes);
  const result = await runCli(['search', 'test', '--mode', 'fulltext', '--json']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /not a database|malformed/i);
  assert.deepEqual(readFileSync(filename), bytes);
});

function watcherService(failure?: 'startup' | 'running') {
  const loader = `
    export async function resolve(specifier, context, next) {
      const resolved = await next(specifier, context);
      if (specifier !== 'chokidar') return resolved;
      const source = ${JSON.stringify(failure)} === 'startup'
        ? "throw new Error('injected watcher unavailable');"
        : 'import { watch as realWatch } from ' + JSON.stringify(resolved.url) + ';' +
          'export function watch(...args) { const watcher = realWatch(...args);' +
          'process.once("message", () => watcher.emit("error", new Error("injected watcher unavailable")));' +
          'return watcher; }';
      return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };
    }
  `;
  return script(`
    import { register } from 'node:module';
    ${failure ? `register('data:text/javascript,' + encodeURIComponent(${JSON.stringify(loader)}));` : ''}
    const { openIndexDatabase, createIndexService } = await import(${JSON.stringify(serviceModule)});
    const { closeDb } = await import(${JSON.stringify(dbModule)});
    await openIndexDatabase();
    const service = createIndexService();
    service.start();
    process.on('message', () => {});
    process.send({ ready: true });
    process.stdin.resume();
    process.stdin.on('end', () => {
      void service.close().then(() => { closeDb(); process.exit(0); }, error => {
        console.error(error); closeDb(); process.exit(1);
      });
    });
  `);
}

it.each(['startup', 'running'] as const)(
  'a fatal %s watcher failure yields to a healthy process without manual restart',
  async (phase) => {
    await seed();
    const failed = watcherService(phase);
    await firstMessage(failed);
    if (phase === 'running') {
      await waitUntil(() => failed.stderr().includes('Indexing complete'));
      assert.ok(owner().token);
      failed.child.send('fail');
    }
    await waitUntil(() => failed.stderr().includes('indexing stopped'));
    await waitUntil(() => owner().token === null);
    assert.match(failed.stderr(), /injected watcher unavailable/);
    assert.equal(
      inspect((db) =>
        db.prepare("SELECT count(*) FROM index_failures WHERE operation='watcher'").pluck().get(),
      ),
      1,
    );
    const follower = watcherService();
    await firstMessage(follower);
    writeFileSync(path.join(vault, 'later.md'), 'A new source after the watcher owner failed.');
    await waitUntil(() =>
      inspect((db) => !!db.prepare("SELECT 1 FROM notes WHERE path='later.md'").get()),
    );
    assert.ok(owner().token, 'a healthy follower owns indexing');
    assert.equal(failed.child.exitCode, null, 'the failed process remains available for reads');
    assert.equal(failed.stderr().match(/indexing stopped/g)?.length, 1);
    assert.equal(
      inspect((db) =>
        db.prepare("SELECT count(*) FROM index_failures WHERE operation='watcher'").pluck().get(),
      ),
      0,
      'a successfully started watcher clears the persisted failure',
    );
    assert.equal(
      inspect((db) => db.prepare('PRAGMA integrity_check').pluck().get()),
      'ok',
    );
  },
);

it('an entirely failed watcher group releases ownership and does not alternate retries', async () => {
  await seed();
  const workers = [watcherService('startup'), watcherService('startup')];
  await Promise.all(workers.map(firstMessage));
  await waitUntil(() => workers.every((worker) => worker.stderr().includes('indexing stopped')));
  await waitUntil(() => owner().token === null);
  const settled = owner();
  const calls = requests.length;
  await delay(6500);
  assert.deepEqual(owner(), settled, 'failed services must not claim or renew ownership again');
  assert.equal(requests.length, calls, 'failed services must not keep probing or embedding');
  for (const worker of workers) assert.equal(worker.stderr().match(/indexing stopped/g)?.length, 1);
});
