import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { localModelEnv } from './run-command.mjs';

const TIMEOUT = 180_000;
const note = 'notes/Astronomy.md';
const hidden = 'packagedhiddenneedle';
const contentPattern = String.raw`/%%[\s\S]*?%%/g`;
function assertSearch(results) {
  assert.ok(
    Array.isArray(results) && results.some((item) => item.path === note),
    JSON.stringify(results),
  );
}
function assertStatus(status) {
  assert.equal(status.total, 4);
  assert.equal(status.failed_chunks, 0);
  assert.equal(status.api_base_url, null);
  assert.equal(status.model, 'local:Xenova/multilingual-e5-small');
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}
function start(cli, args, env) {
  const child = spawn(process.execPath, [cli, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', (data) => process.stderr.write(data));
  return child;
}
async function jsonLines(cli, env) {
  const child = start(cli, ['serve', '--stdio'], env);
  const lines = createInterface({ input: child.stdout });
  const received = [];
  const waiting = [];
  let failure;
  const fail = (error) => {
    failure = error;
    for (const waiter of waiting.splice(0)) waiter.reject(error);
  };
  child.on('error', fail);
  child.on('exit', (code, signal) =>
    fail(new Error(`JSON-lines process exited: ${code}/${signal}`)),
  );
  lines.on('line', (line) => {
    try {
      const value = JSON.parse(line);
      const waiter = waiting.shift();
      if (waiter) waiter.resolve(value);
      else received.push(value);
    } catch (error) {
      fail(error);
    }
  });
  const next = () => {
    if (failure) return Promise.reject(failure);
    if (received.length) return Promise.resolve(received.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('JSON-lines response timeout')), TIMEOUT);
      waiting.push({
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  };
  try {
    assert.equal((await next()).ready, true);
    for (const [request, check] of [
      [
        { id: 'search-17', query: 'astronomy', options: { mode: 'fulltext' } },
        (response) => assertSearch(response.results),
      ],
      [
        { id: 'hidden-18', query: hidden, options: { mode: 'fulltext' } },
        (response) => assert.deepEqual(response.results, []),
      ],
      [{ id: 'status-23', action: 'status' }, (response) => assertStatus(response.status)],
      [{ id: 'invalid-4', query: 27 }, (response) => assert.match(response.error, /Invalid/)],
    ]) {
      child.stdin.write(`${JSON.stringify(request)}\n`);
      const response = await next();
      assert.equal(response.id, request.id);
      check(response);
    }
    child.stdin.write('not json\n');
    const invalid = await next();
    assert.equal(invalid.id, 'unknown');
    assert.ok(invalid.error);
  } finally {
    lines.close();
    await stop(child);
  }
}
async function checkMcp(transport) {
  const client = new Client({ name: 'packaged-smoke', version: '1.0.0' });
  try {
    await client.connect(transport, { timeout: TIMEOUT });
    const { tools } = await client.listTools();
    for (const name of ['search', 'read', 'status', 'reindex'])
      assert.ok(tools.some((tool) => tool.name === name));
    const call = async (name, args) => {
      const result = await client.callTool({ name, arguments: args }, undefined, {
        timeout: TIMEOUT,
      });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      return result.content
        .filter((item) => item.type === 'text')
        .map((item) => item.text)
        .join('\n');
    };
    assertSearch(
      JSON.parse(await call('search', { query: 'astronomy', mode: 'fulltext' })).results,
    );
    const read = JSON.parse(await call('read', { paths: [note] }));
    assert.equal(read.results[0].path, note);
    assert.match(read.results[0].content, /planets/);
    assert.ok(read.results[0].content.includes(hidden));
    assert.deepEqual(
      JSON.parse(await call('search', { query: hidden, mode: 'fulltext' })).results,
      [],
    );
    assertStatus(JSON.parse(await call('status', {})));
    const invalid = await client.callTool({ name: 'search', arguments: { query: 27 } });
    assert.equal(invalid.isError, true);
  } finally {
    await client.close();
    await transport.close();
  }
}
async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}
async function http(cli, env) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = start(
    cli,
    ['serve', '--http', '--foreground', '--host', '127.0.0.1', '--port', String(port)],
    env,
  );
  child.stdout.resume();
  let spawnError;
  child.on('error', (error) => {
    spawnError = error;
  });
  try {
    const deadline = Date.now() + TIMEOUT;
    while (true) {
      if (spawnError) throw spawnError;
      assert.equal(child.exitCode, null, 'HTTP process exited before readiness');
      assert.equal(child.signalCode, null, 'HTTP process cancelled before readiness');
      let ready = false;
      try {
        const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) });
        ready = response.ok && (await response.json()).ok === true;
      } catch {
        /* The process has not bound its socket yet. */
      }
      if (ready) break;
      assert.ok(Date.now() < deadline, 'HTTP readiness timeout');
      await delay(100);
    }
    await checkMcp(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  } finally {
    await stop(child);
  }
}

export async function smokeProcess(packageRoot, inheritedEnv = process.env) {
  const root = mkdtempSync(path.join(tmpdir(), 'ohs-packaged-process-'));
  const cli = path.join(packageRoot, 'dist/src/cli.js');
  const env = {
    ...localModelEnv(inheritedEnv),
    OBSIDIAN_VAULT_PATH: root,
    XDG_CACHE_HOME: path.join(root, '.cache'),
    OBSIDIAN_PREFIX: '',
    OBSIDIAN_INCLUDE_PATTERNS: '',
    OBSIDIAN_IGNORE_PATTERNS: '.cache/**',
    OBSIDIAN_RESPECT_GITIGNORE: 'false',
    OBSIDIAN_CONTENT_IGNORE_PATTERNS: '',
  };
  try {
    mkdirSync(path.join(root, 'notes'));
    mkdirSync(path.join(root, 'kitchen'));
    const original = `---\ntags: [science, focus]\nstatus: active\n---\n# Astronomy\nAstronomy studies planets and stars in the universe. Telescopes observe distant planets and galaxies. See [[Stars]].\n%%${hidden}%%\n`;
    writeFileSync(path.join(root, note), original);
    writeFileSync(
      path.join(root, 'notes/Stars.md'),
      '# Stars\nStars are luminous spheres of plasma. Astronomy studies their light, mass and life cycles across the universe.\n',
    );
    writeFileSync(
      path.join(root, 'notes/Orbits.md'),
      '# Orbits\nPlanets follow elliptical orbits around the sun. Gravity determines orbital trajectories and astronomical periods.\n',
    );
    writeFileSync(
      path.join(root, 'kitchen/Bread.md'),
      '# Bread\nBread is baked with flour, water and yeast. Knead the dough and let it rise before baking in a hot kitchen oven.\n',
    );
    const run = (args, json = true, overrides = {}) => {
      const result = spawnSync(process.execPath, [cli, ...args], {
        env: { ...env, ...overrides },
        cwd: root,
        encoding: 'utf8',
        timeout: TIMEOUT,
      });
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
      return json ? JSON.parse(result.stdout) : result.stdout;
    };
    run(['reindex'], false);
    assertStatus(run(['status']));
    for (const mode of ['hybrid', 'semantic', 'fulltext', 'title'])
      assertSearch(run(['search', 'astronomy', '--mode', mode, '--json']));
    const filtered = run([
      'search',
      'astronomy',
      '--mode',
      'fulltext',
      '--scope',
      'notes/',
      '--tag',
      'focus',
      '--frontmatter',
      'status:active',
      '--json',
    ]);
    assert.deepEqual(
      filtered.map((item) => item.path),
      [note],
    );
    assertSearch(run(['search', '--path', note, '--related', '--json']));
    const similar = run(['search', '--path', note, '--json']);
    assert.ok(similar.some((item) => item.path === 'notes/Orbits.md'));
    assert.ok(similar.every((item) => item.path !== note));
    const read = run(['read', note, '--json']);
    assert.equal(read[0].path, note);
    assert.match(read[0].content, /planets/);
    assertSearch(run(['search', hidden, '--mode', 'fulltext', '--json']));
    env.OBSIDIAN_CONTENT_IGNORE_PATTERNS = contentPattern;
    run(['reindex'], false);
    assert.deepEqual(run(['search', hidden, '--mode', 'fulltext', '--json']), []);
    assert.ok(run(['read', note, '--json'])[0].content.includes(hidden));
    assert.equal(
      run(['read', note, '--raw'], false, { OBSIDIAN_CONTENT_IGNORE_PATTERNS: '/[/g' }),
      original,
    );
    await jsonLines(cli, env);
    for (const args of [[cli, 'mcp'], [path.join(packageRoot, 'dist/src/server.js')]]) {
      await checkMcp(
        new StdioClientTransport({ command: process.execPath, args, env, stderr: 'inherit' }),
      );
    }
    await http(cli, env);
    env.OBSIDIAN_CONTENT_IGNORE_PATTERNS = '';
    run(['reindex'], false);
    assertSearch(run(['search', hidden, '--mode', 'fulltext', '--json']));
    console.log('installed CLI, JSON-lines, MCP stdio (both bins) and MCP HTTP smoke passed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
