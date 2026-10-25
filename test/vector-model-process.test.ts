import Database from 'better-sqlite3';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as sqliteVec from 'sqlite-vec';
import { it, vi } from 'vitest';

it('the public CLI binds the first vector after empty.md and preserves it against another model', async () => {
  const vault = mkdtempSync(path.join(tmpdir(), 'ohs-cli-vector-model-'));
  const source = 'An orchard requires care throughout the growing season.';
  writeFileSync(path.join(vault, 'empty.md'), '');
  writeFileSync(path.join(vault, 'a.md'), source);
  writeFileSync(path.join(vault, 'b.md'), 'A second original source note.');
  async function handleRequest(request: IncomingMessage, response: ServerResponse) {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET') {
      response.end(JSON.stringify({ context_length: 512 }));
      return;
    }
    let raw = '';
    for await (const part of request) raw += String(part);
    const body = JSON.parse(raw) as { model: string; input: string | string[] };
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    response.end(
      JSON.stringify({
        data: inputs.map((_, index) => ({
          index,
          embedding: body.model === 'model-A' ? [1, 0] : [0, 1],
        })),
      }),
    );
  }
  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  async function reindex(model: string, file: string) {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'reindex', file], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OBSIDIAN_VAULT_PATH: vault,
        OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
        OPENAI_EMBEDDING_MODEL: model,
        OBSIDIAN_IGNORE_PATTERNS: '',
        OBSIDIAN_CONTENT_IGNORE_PATTERNS: '',
        OBSIDIAN_RESPECT_GITIGNORE: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stdout.resume();
    child.stderr.on('data', (part) => {
      stderr += String(part);
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000);
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      return { code, stderr };
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await new Promise((resolve) => child.once('close', resolve));
      }
    }
  }
  function snapshot() {
    const connection = new Database(path.join(vault, '.obsidian-hybrid-search.db'));
    sqliteVec.load(connection);
    try {
      return {
        model: connection
          .prepare("SELECT value FROM settings WHERE key='embedding_model'")
          .pluck()
          .get(),
        notes: connection.prepare('SELECT * FROM notes ORDER BY path').all(),
        chunks: connection.prepare('SELECT * FROM chunks ORDER BY id').all(),
        vectors: connection
          .prepare('SELECT chunk_id,hex(embedding) bytes FROM vec_chunks ORDER BY chunk_id')
          .all(),
      };
    } finally {
      connection.close();
    }
  }
  try {
    assert.equal((await reindex('model-A', 'empty.md')).code, 0);
    assert.equal((await reindex('model-A', 'a.md')).code, 0);
    const before = snapshot();
    assert.equal(before.model, 'model-A');
    assert.equal(before.vectors.length, 1);
    const other = await reindex('model-B', 'b.md');
    assert.notEqual(other.code, 0);
    assert.match(other.stderr, /model mismatch.*--force/is);
    assert.deepEqual(snapshot(), before);
    assert.equal(readFileSync(path.join(vault, 'a.md'), 'utf8'), source);
    assert.equal(readFileSync(path.join(vault, 'b.md'), 'utf8'), 'A second original source note.');

    // Keep this reader open, then publish a same-dimensional model switch from
    // a separate CLI process. Both regular search caches must reject the space.
    const environment = {
      OBSIDIAN_VAULT_PATH: vault,
      OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
      OPENAI_EMBEDDING_MODEL: 'model-A',
    };
    const previous = Object.fromEntries(
      Object.keys(environment).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, environment);
    const storage = await import('../src/storage/db.js');
    try {
      const { search } = await import('../src/search/searcher.js');
      storage.openDb();
      for (const mode of ['semantic', 'hybrid'] as const) {
        const results = await search('orchard', { mode });
        assert.deepEqual(
          results.map((result) => [result.path, result.scores.semantic]),
          [['a.md', 1]],
        );
      }
      const rebuilt = await reindex('model-B', '--force');
      assert.equal(rebuilt.code, 0, rebuilt.stderr);
      assert.equal(storage.getStoredModel(), 'model-B');
      await assert.rejects(search('orchard', { mode: 'semantic' }), /embedding model mismatch/i);
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const lexical = await search('orchard', { mode: 'hybrid' });
        assert.deepEqual(
          lexical.map((result) => [result.path, result.scores.semantic]),
          [['a.md', null]],
        );
        assert.match(
          stderr.mock.calls.map(([message]) => String(message)).join(''),
          /model-B.*model-A/,
        );
      } finally {
        stderr.mockRestore();
      }
      const similar = await search('', { notePath: 'a.md' });
      assert.deepEqual(
        similar.map((result) => [result.path, result.score]),
        [['b.md', 1]],
      );
    } finally {
      storage.closeDb();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(vault, { recursive: true, force: true });
  }
});
