import Database from 'better-sqlite3';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import * as sqliteVec from 'sqlite-vec';
import { afterEach, beforeEach, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'dist/src/cli.js');
const rule = '/%%[\\s\\S]*?%%/g';
let vault: string;
let endpoint: string;
let requests: string[][];
let provider: ReturnType<typeof createServer>;
let children: Array<{ child: ChildProcess; closed: Promise<void> }>;
let held: Array<() => void>;
let hold = false;

beforeEach(async () => {
  vault = mkdtempSync(path.join(tmpdir(), 'ohs-content-process-'));
  children = [];
  requests = [];
  held = [];
  hold = false;
  provider = createServer((request, response) => {
    const parts: Buffer[] = [];
    request.on('data', (part: Buffer) => parts.push(part));
    request.on('end', () => {
      response.setHeader('content-type', 'application/json');
      if (request.method !== 'POST') {
        response.end(JSON.stringify({ data: [] }));
        return;
      }
      const { input } = JSON.parse(Buffer.concat(parts).toString()) as { input: string[] };
      requests.push(input);
      const reply = () =>
        response.end(
          JSON.stringify({
            data: input.map((_text, index) => ({ index, embedding: [1, 0, 0, 0] })),
          }),
        );
      if (hold && !input.includes('dimension probe')) held.push(reply);
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
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const timeout = setTimeout(() => child.kill('SIGKILL'), 2000);
      try {
        await closed;
      } finally {
        clearTimeout(timeout);
      }
    }),
  );
  provider.closeAllConnections();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  rmSync(vault, { recursive: true, force: true });
});

function env(patterns: string): NodeJS.ProcessEnv {
  const clean = { ...process.env };
  for (const key of Object.keys(clean))
    if (/^(OBSIDIAN_|OPENAI_|LOCAL_EMBEDDING_)/.test(key)) delete clean[key];
  return {
    ...clean,
    OBSIDIAN_VAULT_PATH: vault,
    OPENAI_BASE_URL: endpoint,
    OPENAI_API_KEY: 'loopback',
    OPENAI_EMBEDDING_MODEL: 'content-test',
    OBSIDIAN_CONTENT_IGNORE_PATTERNS: patterns,
    OBSIDIAN_DEBOUNCE_MS: '50',
    OBSIDIAN_RESPECT_GITIGNORE: 'false',
  };
}
function launch(args: string[], patterns = '') {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: vault,
    env: env(patterns),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  children.push({ child, closed });
  return { child, closed, stdout: () => stdout, stderr: () => stderr };
}
async function runCli(args: string[], patterns = '') {
  const process = launch(args, patterns);
  await process.closed;
  assert.equal(process.child.exitCode, 0, process.stderr());
  return process.stdout();
}
async function stop(process: ReturnType<typeof launch>) {
  process.child.kill('SIGTERM');
  await process.closed;
}
async function waitUntil(predicate: () => boolean, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for content policy process');
    await delay(25);
  }
}
function inspect<T>(read: (db: Database.Database) => T): T {
  const db = new Database(path.join(vault, '.obsidian-hybrid-search.db'));
  sqliteVec.load(db);
  try {
    return read(db);
  } finally {
    db.close();
  }
}
function content(name = 'café.md') {
  return inspect((db) => db.prepare('SELECT content FROM notes WHERE path=?').pluck().get(name)) as
    string | undefined;
}
function policy() {
  return inspect((db) =>
    db.prepare("SELECT value FROM settings WHERE key='content_policy'").pluck().get(),
  ) as string;
}
function failures() {
  return inspect((db) =>
    db.prepare('SELECT path,attempts,last_failed_at FROM index_failures ORDER BY path').all(),
  ) as Array<{ path: string; attempts: number; last_failed_at: string }>;
}
function snapshot() {
  return inspect((db) =>
    JSON.stringify(
      ['notes', 'chunks', 'vec_chunks', 'links', 'markdown_links', 'note_urls', 'settings'].map(
        (table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()],
      ),
    ),
  );
}
async function mcp(patterns = '') {
  const process = launch(['mcp'], patterns);
  let sequence = 0;
  const pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  createInterface({ input: process.child.stdout }).on('line', (line) => {
    const message = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
    if (message.id === undefined) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  const call = (method: string, params: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP timeout ${process.stderr()}`));
      }, 12000);
      pending.set(id, { resolve, reject, timer });
      process.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  await call('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'content-test', version: '1' },
  });
  process.child.stdin.write(
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
  );
  return { ...process, call };
}

it('keeps old MCP processes as readers through enable and disable without policy ping-pong', async () => {
  const source = path.join(vault, 'café.md');
  writeFileSync(source, 'Visible planetary text.\n%%hiddenneedle%%');
  await runCli(['reindex']);
  const old = await mcp();
  await waitUntil(() =>
    inspect((db) => !!db.prepare('SELECT token FROM index_owner').pluck().get()),
  );
  const firstFiltered = await mcp(rule);
  await waitUntil(() => policy() !== 'none' && !content()?.includes('hiddenneedle'));
  const filteredPolicy = policy();
  await stop(firstFiltered);
  await waitUntil(() => old.stderr().includes('Content policy changed'));
  const filtered = await mcp(rule);
  writeFileSync(source, 'Edited planetary text.\n%%hiddenneedle%%');
  await waitUntil(() => content()?.includes('Edited') === true);
  const baselineCalls = requests.length;
  const version = inspect((db) =>
    db.prepare("SELECT value FROM settings WHERE key='db_version'").pluck().get(),
  );
  for (let i = 0; i < 3; i++) {
    await delay(6000);
    assert.equal(policy(), filteredPolicy);
    assert.ok(!content()?.includes('hiddenneedle'));
    const read = await old.call('tools/call', { name: 'read', arguments: { paths: 'café.md' } });
    assert.match(JSON.stringify(read), /hiddenneedle/);
    assert.match(
      await runCli(['search', 'planetary', '--mode', 'fulltext', '--json'], '/unterminated'),
      /café/,
    );
    await runCli(['status'], '/unterminated');
  }
  assert.equal(requests.length, baselineCalls);
  assert.equal(
    inspect((db) => db.prepare("SELECT value FROM settings WHERE key='db_version'").pluck().get()),
    version,
  );
  assert.equal((old.stderr().match(/Content policy changed/g) ?? []).length, 1);

  const firstIdentity = await mcp();
  await waitUntil(() => policy() === 'none' && content()?.includes('hiddenneedle') === true);
  await stop(firstIdentity);
  await waitUntil(() => filtered.stderr().includes('Content policy changed'));
  const identity = await mcp();
  writeFileSync(source, 'Final planetary text.\n%%hiddenneedle%%');
  await waitUntil(() => content()?.includes('Final') === true);
  const calls = requests.length;
  await delay(18000);
  assert.equal(policy(), 'none');
  assert.match(content()!, /hiddenneedle/);
  assert.equal(requests.length, calls);
  assert.match(
    JSON.stringify(await identity.call('tools/call', { name: 'status', arguments: {} })),
    /failed_indexing/,
  );
  assert.equal(
    inspect((db) => db.prepare('PRAGMA integrity_check').pluck().get()),
    'ok',
  );
  assert.deepEqual(
    inspect((db) => db.prepare('PRAGMA foreign_key_check').all()),
    [],
  );
}, 90000);

it('keeps a timed-out source idle, indexes its untouched sibling and recovers after an edit', async () => {
  const bad = path.join(vault, 'a-bad.md');
  const good = path.join(vault, 'b-good.md');
  const patterns = '/(a+)+$/';
  writeFileSync(bad, 'Original bad-file snapshot.');
  writeFileSync(good, 'Original sibling snapshot.');
  await runCli(['reindex'], patterns);
  const server = await mcp(patterns);
  await waitUntil(() =>
    inspect((db) => !!db.prepare('SELECT token FROM index_owner').pluck().get()),
  );
  writeFileSync(bad, `${'a'.repeat(32000)}!`);
  writeFileSync(good, 'Queued valid sibling is searchable.');
  await waitUntil(
    () =>
      failures().some((failure) => failure.path === 'a-bad.md') &&
      content('b-good.md') === 'Queued valid sibling is searchable.',
  );
  assert.equal(content('a-bad.md'), 'Original bad-file snapshot.');
  const failed = failures();
  assert.deepEqual(
    failed.map(({ path }) => path),
    ['a-bad.md'],
  );
  const calls = requests.length;
  await delay(12000);
  assert.deepEqual(failures(), failed);
  assert.equal(requests.length, calls);
  assert.equal((server.stderr().match(/Content filtering timed out/g) ?? []).length, 1);
  writeFileSync(bad, 'Edited healthy source is searchable.');
  await waitUntil(
    () => content('a-bad.md') === 'Edited healthy source is searchable.' && failures().length === 0,
  );
  assert.equal(
    inspect((db) => db.prepare('PRAGMA integrity_check').pluck().get()),
    'ok',
  );
}, 45000);

it('preserves the active snapshot after owner death mid-policy preparation and recovers after lease expiry', async () => {
  writeFileSync(path.join(vault, 'café.md'), 'Visible planetary text.\n%%hiddenneedle%%');
  await runCli(['reindex']);
  const before = snapshot();
  hold = true;
  const transition = launch(['reindex'], rule);
  await waitUntil(() => held.length > 0);
  transition.child.kill('SIGTERM');
  await transition.closed;
  assert.equal(snapshot(), before);
  hold = false;
  held.forEach((reply) => reply());
  held = [];
  await runCli(['reindex'], rule);
  assert.ok(!content()?.includes('hiddenneedle'));
  assert.equal(
    inspect((db) => db.prepare('PRAGMA integrity_check').pluck().get()),
    'ok',
  );
}, 60000);
