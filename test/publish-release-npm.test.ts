import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE_SCRIPT = path.join(ROOT, 'scripts', 'publish-release-npm.mjs');
const cleanupTasks: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanupTasks.splice(0).reverse()) {
    await cleanup();
  }
});

async function startRegistry(statuses: number[]): Promise<{
  acceptHeaders: Array<string | undefined>;
  requests: string[];
  url: string;
}> {
  let requestIndex = 0;
  const acceptHeaders: Array<string | undefined> = [];
  const requests: string[] = [];
  const server = createServer((req, res) => {
    acceptHeaders.push(req.headers.accept);
    requests.push(req.url ?? '');
    const status = statuses[Math.min(requestIndex, statuses.length - 1)] ?? 500;
    requestIndex += 1;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify(
        status === 200
          ? { name: 'example-package', version: '1.2.3' }
          : { error: status === 404 ? 'not found' : 'registry unavailable' },
      ),
    );
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanupTasks.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );

  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { acceptHeaders, requests, url: `http://127.0.0.1:${address.port}/` };
}

function createProject(): { npmLog: string; root: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'ohs-release-npm-'));
  const fakeBin = path.join(root, 'bin');
  const npmLog = path.join(root, 'npm-invocations.jsonl');
  mkdirSync(fakeBin);
  writeFileSync(
    path.join(root, 'package.json'),
    `${JSON.stringify({ name: 'example-package', version: '1.2.3' }, null, 2)}\n`,
  );

  const fakeNpm = path.join(fakeBin, 'npm');
  writeFileSync(
    fakeNpm,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(Number(process.env.FAKE_NPM_EXIT_CODE));
`,
  );
  chmodSync(fakeNpm, 0o755);
  cleanupTasks.push(() => rmSync(root, { force: true, recursive: true }));

  return { npmLog, root };
}

async function runHelper(
  root: string,
  registry: string,
  npmLog: string,
  overrides: Record<string, string> = {},
): Promise<{ status: number | null; stderr: string; stdout: string }> {
  const child = spawn(process.execPath, [RELEASE_SCRIPT], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`,
      FAKE_NPM_LOG: npmLog,
      FAKE_NPM_EXIT_CODE: '0',
      NPM_CONFIG_REGISTRY: registry,
      NPM_VISIBILITY_DELAY_MS: '0',
      NPM_VISIBILITY_MAX_ATTEMPTS: '3',
      ...overrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf-8');
  child.stderr.setEncoding('utf-8');
  child.stdout.on('data', (chunk: string) => (stdout += chunk));
  child.stderr.on('data', (chunk: string) => (stderr += chunk));
  const [status] = (await once(child, 'close')) as [number | null];
  return { status, stderr, stdout };
}

function npmInvocations(npmLog: string): string[][] {
  if (!existsSync(npmLog)) return [];
  return readFileSync(npmLog, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

describe('release npm publication', () => {
  it('skips npm publish when the exact version already exists', async () => {
    const registry = await startRegistry([200]);
    const project = createProject();

    const result = await runHelper(project.root, registry.url, project.npmLog);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(npmInvocations(project.npmLog), []);
    assert.match(result.stdout, /example-package@1\.2\.3 is already published/);
    assert.deepEqual(registry.requests, ['/example-package/1.2.3']);
    assert.deepEqual(registry.acceptHeaders, ['application/json']);
  });

  it('publishes a missing version and waits until it becomes visible', async () => {
    const registry = await startRegistry([404, 404, 200]);
    const project = createProject();

    const result = await runHelper(project.root, registry.url, project.npmLog);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(npmInvocations(project.npmLog), [
      ['publish', '--provenance', '--access', 'public'],
    ]);
    assert.match(result.stdout, /is visible in the npm registry/);
    assert.deepEqual(registry.requests, [
      '/example-package/1.2.3',
      '/example-package/1.2.3',
      '/example-package/1.2.3',
    ]);
  });

  it('fails immediately on a non-404 registry response', async () => {
    const registry = await startRegistry([500]);
    const project = createProject();

    const result = await runHelper(project.root, registry.url, project.npmLog);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /status 500/);
    assert.deepEqual(npmInvocations(project.npmLog), []);
    assert.equal(registry.requests.length, 1);
  });

  it('times out after the configured visibility attempts', async () => {
    const registry = await startRegistry([404]);
    const project = createProject();

    const result = await runHelper(project.root, registry.url, project.npmLog, {
      NPM_VISIBILITY_MAX_ATTEMPTS: '2',
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not visible after 2 attempts/);
    assert.deepEqual(npmInvocations(project.npmLog), [
      ['publish', '--provenance', '--access', 'public'],
    ]);
    assert.equal(registry.requests.length, 3);
  });

  it('propagates an npm publish failure without polling', async () => {
    const registry = await startRegistry([404]);
    const project = createProject();

    const result = await runHelper(project.root, registry.url, project.npmLog, {
      FAKE_NPM_EXIT_CODE: '23',
    });

    assert.equal(result.status, 23);
    assert.deepEqual(npmInvocations(project.npmLog), [
      ['publish', '--provenance', '--access', 'public'],
    ]);
    assert.equal(registry.requests.length, 1);
  });
});
