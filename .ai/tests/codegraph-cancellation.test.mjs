// Exercise the real launcher/adapters against a package shim whose descendant
// holds stdout open. Advance the real adapter deadline only after process readiness.
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const aiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const deadline = 30_000;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitFor(predicate, timeout = 1500) {
  const until = performance.now() + timeout;
  while (!predicate()) {
    if (performance.now() >= until) return false;
    await new Promise((resolve) => realSetTimeout(resolve, 20));
  }
  return true;
}

function fixture(t, harness, stalledLauncher = false) {
  const root = mkdtempSync(path.join(tmpdir(), 'codegraph-cancel-'));
  const ai = path.join(root, '.ai');
  const packageRoot = path.join(root, 'node_modules', '@colbymchenry', 'codegraph');
  mkdirSync(ai, { recursive: true });
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n');
  writeFileSync(path.join(packageRoot, 'package.json'), '{"bin":{"codegraph":"shim.cjs"}}\n');
  copyFileSync(path.join(aiRoot, 'codegraph.mjs'), path.join(ai, 'codegraph.mjs'));
  const shimPids = path.join(root, 'shim-pids.json');
  const workerPid = path.join(root, 'worker-pid.json');
  writeFileSync(
    path.join(packageRoot, 'shim.cjs'),
    `const { spawnSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');
writeFileSync(${JSON.stringify(shimPids)}, JSON.stringify([process.ppid, process.pid]));
spawnSync(process.execPath, [${JSON.stringify(path.join(packageRoot, 'worker.cjs'))}], { stdio: 'inherit' });
`,
  );
  writeFileSync(
    path.join(packageRoot, 'worker.cjs'),
    `const { writeFileSync } = require('node:fs');
writeFileSync(${JSON.stringify(workerPid)}, String(process.pid));
process.stdout.write('<codegraph_context>unfinished');
process.on('SIGTERM', () => {});
setTimeout(() => process.exit(0), 5000);
`,
  );
  const suffix = harness === 'opencode' ? 'js' : 'ts';
  const adapter = path.join(ai, `adapter.${suffix}`);
  copyFileSync(path.join(aiRoot, 'scripts', harness, `codegraph.${suffix}`), adapter);
  if (stalledLauncher) {
    writeFileSync(
      path.join(ai, 'codegraph.mjs'),
      `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(shimPids)}, JSON.stringify([process.pid]));
writeFileSync(${JSON.stringify(workerPid)}, String(process.pid));
process.stdout.write('<codegraph_context>unfinished');
process.on('SIGTERM', () => {});
setTimeout(() => process.exit(0), 5000);
`,
    );
  }
  const pids = () => [
    ...(existsSync(shimPids) ? JSON.parse(readFileSync(shimPids, 'utf8')) : []),
    ...(existsSync(workerPid) ? [Number(readFileSync(workerPid, 'utf8'))] : []),
  ];
  t.after(() => {
    // Always remove the fixture's exact process chain, including on RED.
    for (const pid of [...new Set(pids())].reverse()) {
      if (!alive(pid)) continue;
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' });
      } else {
        process.kill(pid, 'SIGKILL');
      }
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, adapter, pids, workerPid };
}

async function prompt(f, harness) {
  const module = await import(pathToFileURL(f.adapter).href);
  if (harness === 'opencode') {
    const hooks = await module.CodegraphPromptContext({ directory: f.root });
    const output = {
      message: { id: 'msg', sessionID: 'ses' },
      parts: [{ type: 'text', text: 'How does greet work?' }],
    };
    await hooks['chat.message']({}, output);
    return output.parts;
  }
  let handler;
  module.default({
    on: (_event, fn) => {
      handler = fn;
    },
  });
  return handler({ prompt: 'How does greet work?' }, { cwd: f.root });
}

for (const harness of ['opencode', 'pi']) {
  test(`${harness} returns empty context at its deadline and discards partial output`, async (t) => {
    const f = fixture(t, harness);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = prompt(f, harness);
    assert.ok(await waitFor(() => existsSync(f.workerPid), 5000), 'fixture descendant started');
    const started = performance.now();
    t.mock.timers.tick(deadline);
    let timeout;
    try {
      const result = await Promise.race([
        pending,
        new Promise((_resolve, reject) => {
          timeout = realSetTimeout(
            () => reject(new Error('prompt remained blocked past its deadline')),
            1000,
          );
        }),
      ]);
      assert.ok(
        performance.now() - started < 1500,
        'return is bounded independently of pipe closure',
      );
      assert.deepEqual(
        result,
        harness === 'opencode' ? [{ type: 'text', text: 'How does greet work?' }] : undefined,
      );
    } finally {
      realClearTimeout(timeout);
    }
  });

  test(
    `${harness} does not await close when the launcher ignores cancellation`,
    {
      skip:
        process.platform === 'win32' &&
        'Windows force-kills the fixture tree instead of delivering SIGTERM',
    },
    async (t) => {
      const f = fixture(t, harness, true);
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const pending = prompt(f, harness);
      assert.ok(await waitFor(() => existsSync(f.workerPid), 5000), 'launcher started');
      t.mock.timers.tick(deadline);
      let timeout;
      try {
        const result = await Promise.race([
          pending,
          new Promise((_resolve, reject) => {
            timeout = realSetTimeout(
              () => reject(new Error('adapter waited for launcher close')),
              1000,
            );
          }),
        ]);
        assert.deepEqual(
          result,
          harness === 'opencode' ? [{ type: 'text', text: 'How does greet work?' }] : undefined,
        );
        assert.ok(f.pids().every(alive), 'the return must precede launcher close');
      } finally {
        realClearTimeout(timeout);
      }
    },
  );

  test(`${harness} cancellation terminates the launcher, shim and pipe-holding descendant`, async (t) => {
    const f = fixture(t, harness);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = prompt(f, harness);
    assert.ok(await waitFor(() => existsSync(f.workerPid), 5000), 'fixture descendant started');
    t.mock.timers.tick(deadline);
    const pids = f.pids();
    assert.equal(pids.length, 3);
    assert.ok(
      await waitFor(() => pids.every((pid) => !alive(pid))),
      `process chain was not reaped: ${pids.filter(alive)}`,
    );
    await pending;
  });
}
