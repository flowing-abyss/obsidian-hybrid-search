import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('the companion serves its local frame and fragment', async (t) => {
  const fragment = "<h1>Price: $$; match: $&; before: $`; after: $'; group: $1</h1>";
  const { child } = startCompanion(t, {
    fragment,
    env: { BRAINSTORM_TOKEN: 'test-literal-token' },
  });
  const info = await waitForStartup(child);
  const response = await fetch(`http://127.0.0.1:${info.port}/`, {
    headers: { Cookie: `brainstorm-key-${info.port}=test-literal-token` },
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  const html = await response.text();
  await t.test('retains literal dollar replacement sequences', () => {
    assert.ok(html.includes(fragment), 'the served HTML retains the complete fragment');
  });
  await t.test('loads no remote frame assets', () => {
    assert.doesNotMatch(html, /(?:src|href)=["']https?:\/\//, 'the companion frame stays local');
  });
});

for (const [name, port] of [
  ['a fresh session', undefined],
  ['an explicit zero port', '0'],
]) {
  test(`${name} advertises and saves the assigned port for authenticated HTTP`, async (t) => {
    const session = startCompanion(t, {
      env: port === undefined ? {} : { BRAINSTORM_PORT: port },
      restrictManualPorts: true,
    });
    const info = await waitForStartup(session.child);
    await assertAuthenticatedSession(info);
    assert.equal(readFileSync(session.portFile, 'utf8'), String(info.port));
    assert.equal(
      readFileSync(session.tokenFile, 'utf8'),
      new URL(info.url).searchParams.get('key'),
    );
    assert.deepEqual(
      JSON.parse(readFileSync(path.join(session.root, 'state', 'server-info'), 'utf8')),
      info,
    );
  });
}

test('a restart reuses the saved port and token, and an explicit port takes precedence', async (t) => {
  const first = startCompanion(t);
  const original = await waitForStartup(first.child);
  await first.stop();
  const env = {
    BRAINSTORM_PORT_FILE: first.portFile,
    BRAINSTORM_TOKEN_FILE: first.tokenFile,
  };
  const restarted = startCompanion(t, { env });
  const reused = await waitForStartup(restarted.child);
  assert.equal(reused.port, original.port);
  assert.equal(reused.url, original.url);
  await assertAuthenticatedSession(reused);
  await restarted.stop();

  // Keep the saved port occupied: an explicit zero must take precedence over it.
  const holder = startCompanion(t, { env: { BRAINSTORM_PORT: String(original.port) } });
  await waitForStartup(holder.child);
  const explicit = startCompanion(t, { env: { ...env, BRAINSTORM_PORT: '0' } });
  const assigned = await waitForStartup(explicit.child);
  assert.notEqual(assigned.port, original.port);
  assert.equal(
    new URL(assigned.url).searchParams.get('key'),
    new URL(original.url).searchParams.get('key'),
  );
  await assertAuthenticatedSession(assigned);
  assert.equal(readFileSync(first.portFile, 'utf8'), String(assigned.port));
});

test('an occupied saved port falls back without changing the original session credentials', async (t) => {
  const first = startCompanion(t);
  const original = await waitForStartup(first.child);
  const env = {
    BRAINSTORM_PORT_FILE: first.portFile,
    BRAINSTORM_TOKEN_FILE: first.tokenFile,
  };
  const fallback = startCompanion(t, {
    env,
    restrictManualPorts: true,
    allowedPort: original.port,
  });
  const assigned = await waitForStartup(fallback.child);
  assert.notEqual(assigned.port, original.port);
  assert.notEqual(
    new URL(assigned.url).searchParams.get('key'),
    new URL(original.url).searchParams.get('key'),
  );
  await assertAuthenticatedSession(assigned);
  await assertAuthenticatedSession(original);
  assert.equal(readFileSync(first.portFile, 'utf8'), String(original.port));
  assert.equal(
    readFileSync(first.tokenFile, 'utf8'),
    new URL(original.url).searchParams.get('key'),
  );
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(fallback.root, 'state', 'server-info'), 'utf8')),
    assigned,
  );

  const explicitToken = startCompanion(t, {
    env: { ...env, BRAINSTORM_TOKEN: 'operator-supplied-token' },
  });
  await assert.rejects(
    waitForStartup(explicitToken.child),
    /refusing fallback with explicit token/,
  );
  assert.equal(readFileSync(first.portFile, 'utf8'), String(original.port));
  assert.equal(
    readFileSync(first.tokenFile, 'utf8'),
    new URL(original.url).searchParams.get('key'),
  );
});

async function assertAuthenticatedSession(info) {
  assert.ok(Number.isInteger(info.port) && info.port > 0 && info.port < 65536);
  const url = new URL(info.url);
  assert.equal(Number(url.port), info.port);
  const unauthenticated = await fetch(url.origin, { signal: AbortSignal.timeout(5000) });
  assert.equal(unauthenticated.status, 403);
  await unauthenticated.text();
  const bootstrap = await fetch(url, { signal: AbortSignal.timeout(5000) });
  assert.equal(bootstrap.status, 200);
  await bootstrap.text();
  const cookie = bootstrap.headers.get('set-cookie');
  assert.equal(
    cookie,
    `brainstorm-key-${info.port}=${url.searchParams.get('key')}; HttpOnly; SameSite=Strict; Path=/`,
  );
  const page = await fetch(url.origin, {
    headers: { Cookie: cookie.split(';')[0] },
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Waiting for the agent to push a screen/);
  const zeroCookie = await fetch(url.origin, {
    headers: { Cookie: `brainstorm-key-0=${url.searchParams.get('key')}` },
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(zeroCookie.status, 403);
  await zeroCookie.text();
}

function startCompanion(t, { env = {}, fragment, restrictManualPorts = false, allowedPort } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'brainstorm-server-'));
  mkdirSync(path.join(root, 'content'));
  if (fragment) writeFileSync(path.join(root, 'content', 'screen.html'), fragment);
  const portFile = env.BRAINSTORM_PORT_FILE ?? path.join(root, 'last-port');
  const tokenFile = env.BRAINSTORM_TOKEN_FILE ?? path.join(root, 'last-token');
  const args = [];
  if (restrictManualPorts) {
    // Reproduce a host rejecting manually selected ports while keeping the real
    // OS-assigned listener and all HTTP/authentication behavior intact.
    const preload = path.join(root, 'restricted-ports.cjs');
    writeFileSync(
      preload,
      `const { Server } = require('node:net');
const listen = Server.prototype.listen;
Server.prototype.listen = function(port, ...args) {
  if (port !== 0 && port !== ${JSON.stringify(allowedPort)}) {
    process.nextTick(() => this.emit('error', Object.assign(new Error('listen EACCES: port reserved'), { code: 'EACCES' })));
    return this;
  }
  return listen.call(this, port, ...args);
};\n`,
    );
    args.push('--require', preload);
  }
  const child = spawn(
    process.execPath,
    [...args, fileURLToPath(new URL('server.cjs', import.meta.url))],
    {
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([name]) => !name.startsWith('BRAINSTORM_')),
        ),
        BRAINSTORM_DIR: root,
        BRAINSTORM_HOST: '127.0.0.1',
        BRAINSTORM_URL_HOST: '127.0.0.1',
        BRAINSTORM_OWNER_PID: String(process.pid),
        BRAINSTORM_PORT_FILE: portFile,
        BRAINSTORM_TOKEN_FILE: tokenFile,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const closed = once(child, 'close');
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  };
  t.after(async () => {
    await stop();
    rmSync(root, { recursive: true, force: true });
  });
  return { child, root, portFile, tokenFile, stop };
}

function waitForStartup(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('companion did not start')), 5000);
    let stdout = '';
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`companion exited ${code}: ${stderr}`));
    });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const lines = stdout.split('\n');
      stdout = lines.pop() ?? '';
      const line = lines.find((item) => item.includes('"type":"server-started"'));
      if (!line) return;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function startupFixture() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
}
test('startup waits for a complete newline-terminated record across chunks', async () => {
  const child = startupFixture();
  const started = waitForStartup(child);
  let settled = false;
  void started.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    assert.doesNotThrow(() => child.stdout.write('log line\n{"type":"server-started","port":'));
    await Promise.resolve();
    assert.equal(settled, false);
    child.stdout.write('1234}');
    await Promise.resolve();
    assert.equal(settled, false);
    child.stdout.write('\n');
    assert.deepEqual(await started, { type: 'server-started', port: 1234 });
  } finally {
    child.emit('exit', 0);
    await started.catch(() => {});
  }
});
test('malformed completed startup records reject the startup promise', async () => {
  const child = startupFixture();
  const started = waitForStartup(child);
  const rejected = assert.rejects(started, SyntaxError);
  try {
    assert.doesNotThrow(() => child.stdout.write('{"type":"server-started","port":\n'));
    await rejected;
  } finally {
    child.emit('exit', 0);
    await rejected.catch(() => {});
  }
});
