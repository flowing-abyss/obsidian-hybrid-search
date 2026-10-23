import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('the companion serves its local frame and fragment', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'brainstorm-literal-'));
  mkdirSync(path.join(root, 'content'));
  const fragment = "<h1>Price: $$; match: $&; before: $`; after: $'; group: $1</h1>";
  writeFileSync(path.join(root, 'content', 'screen.html'), fragment);
  const child = spawn(process.execPath, [fileURLToPath(new URL('server.cjs', import.meta.url))], {
    env: {
      ...process.env,
      BRAINSTORM_DIR: root,
      BRAINSTORM_HOST: '127.0.0.1',
      BRAINSTORM_TOKEN: 'test-literal-token',
      BRAINSTORM_OWNER_PID: String(process.pid),
      BRAINSTORM_OPEN: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill();
      await closed;
    }
    rmSync(root, { recursive: true, force: true });
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
