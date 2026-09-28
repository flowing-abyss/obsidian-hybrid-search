import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import Database from 'better-sqlite3';
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as sqliteVec from 'sqlite-vec';
import { afterEach, beforeEach, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = process.env.OHS_VAULT_CONFIG_CLI ?? path.join(ROOT, 'dist/src/cli.js');
const LEGACY_CLI = process.env.OHS_VAULT_CONFIG_LEGACY_CLI ?? CLI;
const SERVER = path.join(path.dirname(CLI), 'server.js');
const PRELOAD = pathToFileURL(path.join(ROOT, 'dist/test/fixtures/vault-config-preload.js')).href;
const DB_NAME = '.obsidian-hybrid-search.db';
const BODY = `---
tags: [integrity]
aliases: [Original alias]
status: active
---

# Integrity

Original searchable content retained across startup.
Wiki link [[target]], Markdown link [target](target.md), and URL [reference](https://example.invalid/original).
`;
const FIXED_MTIME = 1_700_000_001;

type CliResult = { code: number; stdout: string; stderr: string };
type Snapshot = {
  rows: Record<string, unknown[]>;
  vectors: unknown[];
  provenance: unknown[];
  fts: unknown[];
};
type Request = { model: string; input: string[]; path: string };
type ProcessWatch = {
  exited: () => boolean;
  stderr: () => string;
  error: () => Error | undefined;
};
type ChildHandle = ProcessWatch & {
  child: ChildProcess;
  close: Promise<void>;
  stdout: () => string;
  stop(): Promise<void>;
};

let root: string;
let vaultA: string;
let vaultB: string;
let endpointA: string;
let endpointB: string;
let requests: Request[];
let provider: ReturnType<typeof createServer>;
const children = new Set<ChildHandle>();
const cleanupCallbacks = new Set<() => Promise<void>>();

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'ohs-vault-config-process-'));
  vaultA = path.join(root, 'A');
  vaultB = path.join(root, 'B');
  mkdirSync(vaultA);
  mkdirSync(vaultB);
  requests = [];
  provider = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      response.setHeader('content-type', 'application/json');
      if (request.url?.endsWith('/embeddings')) {
        let payload: { model: string; input: string | string[] };
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof payload;
          if (!payload.model || !payload.input) throw new Error('missing model or input');
        } catch {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: { message: 'malformed embedding request' } }));
          return;
        }
        const input = Array.isArray(payload.input) ? payload.input : [payload.input];
        requests.push({ model: payload.model, input, path: request.url });
        response.end(
          JSON.stringify({
            data: input.map((_, index) => ({
              index,
              object: 'embedding',
              embedding: [1, 0, 0, 0],
            })),
          }),
        );
      } else if (request.url?.includes('/models/')) {
        response.end(JSON.stringify({ context_length: 512 }));
      } else {
        response.statusCode = 400;
        response.end(JSON.stringify({ error: { message: 'unknown fixture route' } }));
      }
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address();
  assert.ok(address && typeof address === 'object');
  endpointA = `http://127.0.0.1:${address.port}/a/v1`;
  endpointB = `http://127.0.0.1:${address.port}/b/v1`;
});

afterEach(async () => {
  const failures: unknown[] = [];
  for (const cleanup of [...cleanupCallbacks]) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  for (const child of [...children]) {
    try {
      await child.stop();
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await new Promise<void>((resolve, reject) =>
      provider.close((error) => (error ? reject(error) : resolve())),
    );
  } catch (error) {
    failures.push(error);
  }
  if (cleanupCallbacks.size === 0 && children.size === 0) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'fixture teardown failed');
});

function childEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(OPENAI_|LOCAL_EMBEDDING_|OBSIDIAN_)/.test(key)) delete env[key];
  }
  delete env.NODE_OPTIONS;
  env.XDG_CACHE_HOME = path.join(root, 'cache');
  env.NODE_OPTIONS = `--import=${PRELOAD}`;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function runCli(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  executable = CLI,
): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [executable, ...args],
      { cwd, env, timeout: 20_000 },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

function snapshot(vault: string): Snapshot {
  const db = new Database(path.join(vault, DB_NAME), { readonly: true });
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
      vectors: db
        .prepare('SELECT chunk_id, hex(embedding) AS bytes FROM vec_chunks ORDER BY chunk_id')
        .all(),
      provenance: db
        .prepare(
          "SELECT key, value FROM settings WHERE key IN ('embedding_model', 'embedding_dim', 'db_version', 'api_base_url', 'api_model', 'ignore_patterns') ORDER BY key",
        )
        .all(),
      fts: db
        .prepare(
          "SELECT rowid FROM notes_fts_bm25 WHERE notes_fts_bm25 MATCH 'Original' ORDER BY rowid",
        )
        .all(),
    };
  } finally {
    db.close();
  }
}

function dbSetting(vault: string, key: string): string | undefined {
  const db = new Database(path.join(vault, DB_NAME));
  try {
    return (
      db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
        { value: string } | undefined
    )?.value;
  } finally {
    db.close();
  }
}

function setDbSetting(vault: string, key: string, value: string): void {
  const db = new Database(path.join(vault, DB_NAME));
  try {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
  } finally {
    db.close();
  }
}

function changeLocatorSetting(dbFile: string, key: string, value?: string): void {
  const db = new Database(dbFile);
  try {
    if (value === undefined) db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    else db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
  } finally {
    db.close();
  }
}

async function seedVault(
  vault: string,
  model: string,
  endpoint: string,
  ignorePatterns: string,
  executable: string,
): Promise<void> {
  const file = path.join(vault, 'keep.md');
  writeFileSync(file, BODY);
  utimesSync(file, FIXED_MTIME, FIXED_MTIME);
  if (vault === vaultA) {
    const target = path.join(vault, 'target.md');
    writeFileSync(target, '# Target\n\nA retained target note for link preservation.\n');
    utimesSync(target, FIXED_MTIME, FIXED_MTIME);
  }
  const result = await runCli(
    ['reindex'],
    vault,
    childEnv({
      OBSIDIAN_VAULT_PATH: vault,
      OPENAI_API_KEY: 'synthetic-loopback-key',
      OPENAI_BASE_URL: endpoint,
      OPENAI_EMBEDDING_MODEL: model,
      OBSIDIAN_IGNORE_PATTERNS: ignorePatterns,
    }),
    executable,
  );
  assert.equal(result.code, 0, result.stderr);
}

function startChild(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  executable = CLI,
): ChildHandle {
  const child = spawn(process.execPath, [executable, ...args], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let processError: Error | undefined;
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  child.once('error', (error: Error) => {
    processError = error;
  });
  let closed = false;
  const close = new Promise<void>((resolve) =>
    child.once('close', () => {
      closed = true;
      resolve();
    }),
  );
  const handle: ChildHandle = {
    child,
    close,
    stdout: () => stdout,
    stderr: () => stderr,
    error: () => processError,
    exited: () => child.exitCode !== null || child.signalCode !== null,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const escalation = setTimeout(() => child.kill('SIGKILL'), 1_000);
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          close,
          new Promise<never>((_, reject) => {
            deadline = setTimeout(() => reject(new Error(`child did not close: ${stderr}`)), 4_000);
          }),
        ]);
      } finally {
        clearTimeout(escalation);
        clearTimeout(deadline);
        if (closed) children.delete(handle);
      }
    },
  };
  children.add(handle);
  return handle;
}

async function pollUntil(
  check: () => boolean | Promise<boolean>,
  handle?: ProcessWatch,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const processError = handle?.error();
    if (processError) throw processError;
    if (handle?.exited()) {
      throw new Error(`child exited before completion: ${handle.stderr()}`);
    }
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for startup completion: ${handle?.stderr() ?? ''}`);
}

function stdioRequest(
  handle: ChildHandle,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const id = String(request.id);
  return new Promise((resolve, reject) => {
    let consumed = 0;
    const deadline = setTimeout(() => {
      cleanup();
      reject(new Error(`stdio request timed out: ${handle.stderr()}`));
    }, 5_000);
    const inspect = () => {
      const lines = handle.stdout().slice(consumed).split('\n');
      consumed = handle.stdout().length - (lines.at(-1)?.length ?? 0);
      for (const line of lines.slice(0, -1)) {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed.id === id) {
            cleanup();
            resolve(parsed);
            return;
          }
        } catch {
          /* Other process output cannot satisfy a JSON-lines response. */
        }
      }
    };
    const onExit = () => {
      cleanup();
      reject(new Error(`child exited before response: ${handle.stderr()}`));
    };
    const cleanup = () => {
      clearTimeout(deadline);
      handle.child.stdout?.off('data', inspect);
      handle.child.off('exit', onExit);
    };
    handle.child.stdout?.on('data', inspect);
    handle.child.once('exit', onExit);
    handle.child.stdin?.write(JSON.stringify(request) + '\n');
    inspect();
  });
}

async function seedPair(
  executable: string,
): Promise<{ beforeA: Snapshot; beforeB: Snapshot; beforeSearch: unknown }> {
  await seedVault(vaultA, 'model-A', endpointA, '', executable);
  await seedVault(vaultB, 'model-B', endpointB, 'keep.md', executable);
  const beforeA = snapshot(vaultA);
  const beforeB = snapshot(vaultB);
  for (const table of [
    'notes',
    'chunks',
    'note_aliases',
    'note_tags',
    'note_frontmatter_fields',
    'links',
    'markdown_links',
    'note_urls',
  ]) {
    assert.ok(beforeA.rows[table]?.length, `A ${table} must be populated`);
  }
  assert.ok(beforeA.vectors.length > 0);
  assert.equal(beforeB.rows.notes?.length, 0);
  assert.equal(beforeB.rows.chunks?.length, 0);
  assert.equal(beforeB.vectors.length, 0);
  assert.ok(
    beforeB.provenance.some(
      (row) =>
        (row as { key: string; value: string }).key === 'api_model' &&
        (row as { value: string }).value === 'model-B',
    ),
  );
  assert.ok(
    beforeB.provenance.some(
      (row) =>
        (row as { key: string; value: string }).key === 'ignore_patterns' &&
        (row as { value: string }).value === '["keep.md"]',
    ),
  );
  const search = await runCli(
    ['search', 'Original', '--mode', 'fulltext', '--json'],
    vaultA,
    childEnv({ OBSIDIAN_VAULT_PATH: vaultA }),
    executable,
  );
  assert.equal(search.code, 0, search.stderr);
  return { beforeA, beforeB, beforeSearch: JSON.parse(search.stdout) as unknown };
}

it('explicit A preserves indexed data while cwd is B', async () => {
  const { beforeA, beforeB, beforeSearch } = await seedPair(LEGACY_CLI);
  setDbSetting(vaultA, 'last_indexed', 'before-startup');
  requests = [];
  const handle = startChild(
    ['serve', '--stdio'],
    vaultB,
    childEnv({ OBSIDIAN_VAULT_PATH: vaultA }),
  );
  try {
    await pollUntil(
      () =>
        handle
          .stdout()
          .split('\n')
          .some((line) => line.includes('"ready":true')),
      handle,
    );
    await pollUntil(() => dbSetting(vaultA, 'last_indexed') !== 'before-startup', handle);
    const reply = await stdioRequest(handle, { id: 'status-1', action: 'status' });
    assert.equal(reply.error, undefined);
    const status = reply.status as Record<string, unknown>;
    assert.equal(
      status.api_base_url,
      endpointA,
      JSON.stringify({
        notesBefore: beforeA.rows.notes?.length,
        notesAfter: snapshot(vaultA).rows.notes?.length,
        vectorsBefore: beforeA.vectors.length,
        vectorsAfter: snapshot(vaultA).vectors.length,
      }),
    );
    assert.equal(status.active_model, 'model-A');
    assert.deepEqual(status.ignore_patterns, []);
    const search = await stdioRequest(handle, {
      id: 'search-1',
      query: 'Original',
      options: { mode: 'fulltext' },
    });
    assert.equal(search.error, undefined);
    assert.deepEqual(search.results, beforeSearch);
  } finally {
    await handle.stop();
  }
  assert.deepEqual(snapshot(vaultA), beforeA);
  assert.deepEqual(snapshot(vaultB), beforeB);
  assert.deepEqual(requests, []);
}, 30_000);

function assertAStatus(status: Record<string, unknown>): void {
  assert.equal(status.api_base_url, endpointA);
  assert.equal(status.active_model, 'model-A');
  assert.deepEqual(status.ignore_patterns, []);
}

async function assertPreserved(
  beforeA: Snapshot,
  beforeB: Snapshot,
  beforeSearch: unknown,
): Promise<void> {
  assertAStatus(await cliStatus(vaultB, { OBSIDIAN_VAULT_PATH: vaultA }));
  assert.deepEqual(snapshot(vaultA), beforeA);
  assert.deepEqual(snapshot(vaultB), beforeB);
  const result = await runCli(
    ['search', 'Original', '--mode', 'fulltext', '--json'],
    vaultB,
    childEnv({ OBSIDIAN_VAULT_PATH: vaultA }),
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), beforeSearch);
  assert.deepEqual(requests, []);
}

function parseMcpStatus(
  response: Awaited<ReturnType<Client['callTool']>>,
): Record<string, unknown> {
  assert.ok(!response.isError);
  const content = response.content as Array<{ type: string; text?: string }>;
  assert.equal(content[0]?.type, 'text');
  return JSON.parse(content[0]?.text ?? '') as Record<string, unknown>;
}

async function mcpStatus(client: Client): Promise<Record<string, unknown>> {
  return parseMcpStatus(
    await client.callTool({ name: 'status', arguments: {} }, undefined, { timeout: 5_000 }),
  );
}

async function startStdioMcp(
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{
  client: Client;
  close: Promise<void>;
  monitor: ProcessWatch;
  stop(): Promise<void>;
}> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [executable, ...args],
    cwd,
    env: Object.fromEntries(
      Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    stderr: 'pipe',
  });
  let stderr = '';
  let processError: Error | undefined;
  let closed = false;
  const close = new Promise<void>((resolve) => {
    transport.onclose = () => {
      closed = true;
      resolve();
    };
  });
  transport.onerror = (error) => {
    processError = error;
  };
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const client = new Client({ name: 'vault-config-process-test', version: '1.0.0' });
  const monitor: ProcessWatch = {
    exited: () => closed,
    error: () => processError,
    stderr: () => stderr,
  };
  let childPid: number | null = null;
  let sdkClose: Promise<void> | undefined;
  let closeError: unknown;
  let closeFailed = false;
  const stop = async () => {
    const pid = childPid ?? transport.pid;
    sdkClose ??= client.close().catch((error: unknown) => {
      closeFailed = true;
      closeError = error;
    });
    const signal = (name: NodeJS.Signals) => {
      if (closed || pid === null) return;
      try {
        process.kill(pid, name);
      } catch {
        /* The fixture child already exited. */
      }
    };
    signal('SIGTERM');
    const escalation = setTimeout(() => signal('SIGKILL'), 1_000);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        close,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error(`MCP child did not close within 4 seconds: ${stderr}`)),
            4_000,
          );
        }),
      ]);
      await sdkClose;
      if (closeFailed) {
        throw closeError instanceof Error ? closeError : new Error(String(closeError));
      }
    } finally {
      clearTimeout(escalation);
      clearTimeout(deadline);
      if (closed) cleanupCallbacks.delete(stop);
    }
  };
  cleanupCallbacks.add(stop);
  await client.connect(transport, { timeout: 5_000 });
  childPid = transport.pid;
  return { client, close, monitor, stop };
}

async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address();
  assert.ok(address && typeof address === 'object');
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function connectHttp(port: number): Promise<{ client: Client; stop(): Promise<void> }> {
  const client = new Client({ name: 'vault-config-http-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  await client.connect(transport, { timeout: 5_000 });
  const stop = () => client.close();
  cleanupCallbacks.add(stop);
  return {
    client,
    stop: async () => {
      await stop();
      cleanupCallbacks.delete(stop);
    },
  };
}

async function waitForIndex(handle?: ProcessWatch): Promise<void> {
  await pollUntil(() => dbSetting(vaultA, 'last_indexed') !== 'before-startup', handle);
}

const restartCases = [
  { name: 'explicit A while cwd B', args: ['serve', '--stdio'], conflictDb: false },
  { name: 'explicit A with --db B', args: ['serve', '--stdio'], conflictDb: true },
  { name: 'CLI MCP', args: ['mcp'], conflictDb: false },
  { name: 'direct MCP', args: [], conflictDb: false },
  { name: 'HTTP foreground', args: ['serve', '--http', '--foreground'], conflictDb: false },
  { name: 'HTTP daemon child', args: ['serve', '--http'], conflictDb: true },
] as const;

it.each(restartCases)(
  '$name restores A defaults before model selection',
  async ({ name, args, conflictDb }) => {
    const { beforeA, beforeB, beforeSearch } = await seedPair(LEGACY_CLI);
    setDbSetting(vaultA, 'last_indexed', 'before-startup');
    requests = [];
    const env = childEnv({ OBSIDIAN_VAULT_PATH: vaultA });
    const actualArgs = conflictDb ? ['--db', path.join(vaultB, DB_NAME), ...args] : [...args];

    if (name === 'explicit A while cwd B' || name === 'explicit A with --db B') {
      const handle = startChild(actualArgs, vaultB, env);
      try {
        await pollUntil(() => handle.stdout().includes('"ready":true'), handle);
        await waitForIndex(handle);
        const response = await stdioRequest(handle, { id: 'status', action: 'status' });
        assertAStatus(response.status as Record<string, unknown>);
      } finally {
        await handle.stop();
      }
    } else if (name === 'CLI MCP' || name === 'direct MCP') {
      const mcp = await startStdioMcp(
        name === 'direct MCP' ? SERVER : CLI,
        actualArgs,
        vaultB,
        env,
      );
      try {
        await waitForIndex(mcp.monitor);
        assertAStatus(await mcpStatus(mcp.client));
      } finally {
        await mcp.stop();
        await mcp.close;
        assert.ok(mcp.monitor.exited(), 'MCP child must close before snapshot reads');
      }
    } else {
      let port = await freePort();
      let startedHttp = false;
      let foreground: ChildHandle | undefined;
      let daemonPid: number | undefined;
      const stateFile = path.join(root, 'cache', 'obsidian-hybrid-search', 'mcp-state.json');
      const stopDaemon = async () => {
        const stopped = await runCli(['serve', 'stop'], vaultB, env);
        if (daemonPid !== undefined) {
          const pid = daemonPid;
          const alive = () => {
            try {
              process.kill(pid, 0);
              return true;
            } catch {
              return false;
            }
          };
          const signal = (name: NodeJS.Signals) => {
            try {
              process.kill(pid, name);
            } catch {
              /* The child already exited. */
            }
          };
          if (stopped.code !== 0 && alive()) signal('SIGTERM');
          let exitDeadline = Date.now() + 1_000;
          while (alive() && Date.now() < exitDeadline) {
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          if (alive()) signal('SIGKILL');
          exitDeadline = Date.now() + 3_000;
          while (alive() && Date.now() < exitDeadline) {
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          assert.ok(!alive(), `fixture daemon ${pid} did not exit: ${stopped.stderr}`);
        }
        cleanupCallbacks.delete(stopDaemon);
      };
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          const httpArgs = [...actualArgs, '--host', '127.0.0.1', '--port', String(port)];
          if (name === 'HTTP daemon child') {
            const started = await runCli(httpArgs, vaultB, env);
            if (started.code !== 0 && /port.*(use|available|conflict)/i.test(started.stderr)) {
              port = await freePort();
              continue;
            }
            assert.equal(started.code, 0, started.stderr);
            cleanupCallbacks.add(stopDaemon);
            const state = JSON.parse(readFileSync(stateFile, 'utf8')) as { pid: number };
            daemonPid = state.pid;
          } else {
            foreground = startChild(httpArgs, vaultB, env);
          }
          try {
            await pollUntil(async () => {
              try {
                const response = await fetch(`http://127.0.0.1:${port}/health`);
                return response.ok;
              } catch {
                return false;
              }
            }, foreground);
          } catch (error) {
            if (foreground && /EADDRINUSE|address already in use/i.test(foreground.stderr())) {
              await foreground.stop();
              foreground = undefined;
              port = await freePort();
              continue;
            }
            throw error;
          }
          startedHttp = true;
          break;
        }
        assert.ok(startedHttp, 'HTTP server could not claim a fixture port in three attempts');
        await waitForIndex(foreground);
        const http = await connectHttp(port);
        try {
          assertAStatus(await mcpStatus(http.client));
        } finally {
          await http.stop();
        }
      } finally {
        if (foreground) await foreground.stop();
        if (name === 'HTTP daemon child') await stopDaemon();
      }
    }
    await assertPreserved(beforeA, beforeB, beforeSearch);
  },
  30_000,
);

it('current-seeded A preserves indexed data while cwd is B', async () => {
  const { beforeA, beforeB, beforeSearch } = await seedPair(CLI);
  setDbSetting(vaultA, 'last_indexed', 'before-startup');
  requests = [];
  const handle = startChild(
    ['serve', '--stdio'],
    vaultB,
    childEnv({ OBSIDIAN_VAULT_PATH: vaultA }),
  );
  try {
    await pollUntil(() => handle.stdout().includes('"ready":true'), handle);
    await waitForIndex(handle);
    const status = await stdioRequest(handle, { id: 'status', action: 'status' });
    assertAStatus(status.status as Record<string, unknown>);
  } finally {
    await handle.stop();
  }
  await assertPreserved(beforeA, beforeB, beforeSearch);
}, 30_000);

async function cliStatus(
  cwd: string,
  overrides: NodeJS.ProcessEnv,
  args: string[] = [],
): Promise<Record<string, unknown>> {
  const result = await runCli([...args, 'status'], cwd, childEnv(overrides));
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

it('relative explicit vault is resolved against the child cwd', async () => {
  const { beforeA, beforeB, beforeSearch } = await seedPair(LEGACY_CLI);
  requests = [];
  const status = await cliStatus(vaultB, { OBSIDIAN_VAULT_PATH: '../A' });
  assertAStatus(status);
  assert.equal(path.resolve(vaultB, String(status.vault)), vaultA);
  await assertPreserved(beforeA, beforeB, beforeSearch);
}, 20_000);

it('fresh explicit A starts with local defaults instead of B defaults', async () => {
  await seedVault(vaultB, 'model-B', endpointB, 'keep.md', LEGACY_CLI);
  const beforeB = snapshot(vaultB);
  const status = await cliStatus(vaultB, { OBSIDIAN_VAULT_PATH: vaultA });
  assert.equal(status.vault, vaultA);
  assert.equal(status.api_base_url, null);
  assert.equal(status.active_model, 'local:Xenova/multilingual-e5-small');
  assert.deepEqual(status.ignore_patterns, ['.obsidian/**', 'templates/**', '*.canvas']);
  assert.deepEqual(snapshot(vaultB), beforeB);
}, 20_000);

it.each(['', '   ', 'missing', 'file.md'])(
  'explicit invalid vault %j fails CLI serve and direct MCP without touching B',
  async (value) => {
    await seedVault(vaultB, 'model-B', endpointB, 'keep.md', LEGACY_CLI);
    const beforeB = snapshot(vaultB);
    const badPath =
      value === 'missing'
        ? path.join(root, 'missing')
        : value === 'file.md'
          ? path.join(root, 'file.md')
          : value;
    if (value === 'file.md') writeFileSync(badPath, 'not a directory');
    for (const [executable, args] of [
      [CLI, ['serve', '--stdio']],
      [SERVER, []],
    ] as const) {
      const result = await runCli(
        [...args],
        vaultB,
        childEnv({ OBSIDIAN_VAULT_PATH: badPath }),
        executable,
      );
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /vault|OBSIDIAN_VAULT_PATH/i);
      assert.ok(!result.stdout.includes('"ready":true'));
    }
    assert.deepEqual(snapshot(vaultB), beforeB);
    if (value === 'missing') assert.ok(!existsSync(path.join(badPath, DB_NAME)));
    if (value === 'file.md') assert.ok(!existsSync(path.join(badPath, DB_NAME)));
  },
  20_000,
);

it('nested no-env cwd uses A for fulltext search and manual serve', async () => {
  await seedVault(vaultA, 'model-A', endpointA, '', LEGACY_CLI);
  const nested = path.join(vaultA, 'nested');
  mkdirSync(nested);
  const search = await runCli(
    ['search', 'Original', '--mode', 'fulltext', '--json'],
    nested,
    childEnv({}),
  );
  assert.equal(search.code, 0, search.stderr);
  assert.ok((JSON.parse(search.stdout) as unknown[]).length > 0);
  setDbSetting(vaultA, 'last_indexed', 'before-startup');
  const handle = startChild(['serve', '--stdio'], nested, childEnv({}));
  try {
    await pollUntil(() => handle.stdout().includes('"ready":true'), handle);
    await waitForIndex(handle);
    const response = await stdioRequest(handle, { id: 'status', action: 'status' });
    assertAStatus(response.status as Record<string, unknown>);
  } finally {
    await handle.stop();
  }
}, 30_000);

it('fresh no-env .obsidian vault supports ordinary reindex and serve', async () => {
  mkdirSync(path.join(vaultA, '.obsidian'));
  writeFileSync(path.join(vaultA, 'note.md'), '# Fresh\n\nFresh searchable content.\n');
  const reindex = await runCli(['reindex'], vaultA, childEnv({}));
  assert.equal(reindex.code, 0, reindex.stderr);
  assert.equal(snapshot(vaultA).rows.notes?.length, 1);
  setDbSetting(vaultA, 'last_indexed', 'before-startup');
  const handle = startChild(['serve', '--stdio'], vaultA, childEnv({}));
  try {
    await pollUntil(() => handle.stdout().includes('"ready":true'), handle);
    await waitForIndex(handle);
    const response = await stdioRequest(handle, { id: 'status', action: 'status' });
    assert.equal(
      (response.status as Record<string, unknown>).active_model,
      'local:Xenova/multilingual-e5-small',
    );
    assert.equal((response.status as Record<string, unknown>).indexed, 1);
  } finally {
    await handle.stop();
  }
}, 30_000);

it('no-env copy.db locator uses canonical A defaults despite B locator settings', async () => {
  const { beforeA, beforeB, beforeSearch } = await seedPair(LEGACY_CLI);
  const locator = path.join(vaultB, 'copy.db');
  copyFileSync(path.join(vaultB, DB_NAME), locator);
  changeLocatorSetting(locator, 'vault_path', vaultA);
  requests = [];
  const status = await cliStatus(vaultB, {}, ['--db', locator]);
  assert.equal(status.vault, vaultA);
  assertAStatus(status);
  await assertPreserved(beforeA, beforeB, beforeSearch);
}, 20_000);

it('no-env copy.db locator without vault metadata uses B canonical defaults', async () => {
  const { beforeA, beforeB } = await seedPair(LEGACY_CLI);
  const locator = path.join(vaultB, 'copy.db');
  copyFileSync(path.join(vaultA, DB_NAME), locator);
  changeLocatorSetting(locator, 'vault_path');
  const status = await cliStatus(vaultB, {}, ['--db', locator]);
  assert.equal(status.vault, vaultB);
  assert.equal(status.api_base_url, endpointB);
  assert.equal(status.active_model, 'model-B');
  assert.deepEqual(status.ignore_patterns, ['keep.md']);
  assert.deepEqual(snapshot(vaultA), beforeA);
  assert.deepEqual(snapshot(vaultB), beforeB);
}, 20_000);

it('a locator with missing canonical A DB uses fresh A defaults', async () => {
  await seedVault(vaultA, 'model-A', endpointA, '', LEGACY_CLI);
  await seedVault(vaultB, 'model-B', endpointB, 'keep.md', LEGACY_CLI);
  const locator = path.join(vaultB, 'copy.db');
  copyFileSync(path.join(vaultB, DB_NAME), locator);
  changeLocatorSetting(locator, 'vault_path', vaultA);
  rmSync(path.join(vaultA, DB_NAME));
  const status = await cliStatus(vaultB, {}, ['--db', locator]);
  assert.equal(status.vault, vaultA);
  assert.equal(status.api_base_url, null);
  assert.equal(status.active_model, 'local:Xenova/multilingual-e5-small');
}, 20_000);

it('explicit provider and ignore overrides take precedence over A saved defaults', async () => {
  const { beforeB } = await seedPair(LEGACY_CLI);
  const status = await cliStatus(vaultB, {
    OBSIDIAN_VAULT_PATH: vaultA,
    OPENAI_BASE_URL: endpointB,
    OPENAI_EMBEDDING_MODEL: 'override-model',
    OBSIDIAN_IGNORE_PATTERNS: 'override.md',
  });
  assert.equal(status.api_base_url, endpointB);
  assert.equal(status.active_model, 'override-model');
  assert.deepEqual(status.ignore_patterns, ['override.md']);
  assert.deepEqual(snapshot(vaultB), beforeB);
}, 20_000);

it('explicit empty ignore wins while empty API variables restore A', async () => {
  await seedVault(vaultA, 'model-A', endpointA, 'keep.md', LEGACY_CLI);
  const status = await cliStatus(vaultB, {
    OBSIDIAN_VAULT_PATH: vaultA,
    OPENAI_BASE_URL: '',
    OPENAI_EMBEDDING_MODEL: '',
    OBSIDIAN_IGNORE_PATTERNS: '',
  });
  assert.equal(status.api_base_url, endpointA);
  assert.equal(status.active_model, 'model-A');
  assert.deepEqual(status.ignore_patterns, []);
}, 20_000);

it('saved OpenAI default URL without key keeps local embedding mode', async () => {
  const first = await cliStatus(vaultA, { OBSIDIAN_VAULT_PATH: vaultA });
  assert.equal(first.api_base_url, null);
  setDbSetting(vaultA, 'api_base_url', 'https://api.openai.com/v1');
  setDbSetting(vaultA, 'api_model', 'text-embedding-3-small');
  const second = await cliStatus(vaultB, { OBSIDIAN_VAULT_PATH: vaultA });
  assert.equal(second.api_base_url, null);
  assert.equal(second.active_model, 'local:Xenova/multilingual-e5-small');
}, 20_000);

it.each([undefined, ''])(
  'serve management bypass works with invalid env %s',
  async (invalid) => {
    const cwd = path.join(root, 'no-vault');
    mkdirSync(cwd);
    const env = childEnv(
      invalid === undefined ? {} : { OBSIDIAN_VAULT_PATH: path.join(root, 'missing') },
    );
    for (const args of [
      ['serve', 'status'],
      ['serve', 'stop'],
    ]) {
      const result = await runCli(args, cwd, env);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /not running/i);
    }
    assert.ok(!existsSync(path.join(cwd, DB_NAME)));
  },
  20_000,
);

it.each(['ignore', 'delete'])(
  '%s intentionally removes only A keep.md on completed startup',
  async (change) => {
    await seedVault(vaultA, 'model-A', endpointA, '', LEGACY_CLI);
    await seedVault(vaultB, 'model-B', endpointB, 'keep.md', LEGACY_CLI);
    const beforeB = snapshot(vaultB);
    const beforeA = snapshot(vaultA);
    const target = (beforeA.rows.notes as Array<{ path: string }>).find(
      (row) => row.path === 'target.md',
    );
    assert.ok(target);
    if (change === 'delete') unlinkSync(path.join(vaultA, 'keep.md'));
    setDbSetting(vaultA, 'last_indexed', 'before-startup');
    const handle = startChild(
      ['serve', '--stdio'],
      vaultB,
      childEnv({
        OBSIDIAN_VAULT_PATH: vaultA,
        ...(change === 'ignore' ? { OBSIDIAN_IGNORE_PATTERNS: 'keep.md' } : {}),
      }),
    );
    try {
      await pollUntil(() => handle.stdout().includes('"ready":true'), handle);
      await waitForIndex(handle);
    } finally {
      await handle.stop();
    }
    const afterA = snapshot(vaultA);
    assert.deepEqual(
      (afterA.rows.notes as Array<{ path: string }>).map((row) => row.path),
      ['target.md'],
    );
    assert.ok(afterA.rows.chunks?.length);
    assert.ok(afterA.vectors.length);
    assert.ok(afterA.vectors.length < beforeA.vectors.length);
    assert.ok(existsSync(path.join(vaultA, 'keep.md')) === (change === 'ignore'));
    assert.deepEqual(snapshot(vaultB), beforeB);
  },
  30_000,
);
