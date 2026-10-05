import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY = 'example/project';
const OTHER_SHA = '2222222222222222222222222222222222222222';
const cleanupTasks: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanupTasks.splice(0).reverse()) await cleanup();
});

function isolatedEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // Hook variables target the invoking repository even when a child has another cwd.
  // Preserve Node/HTTP environment while isolating all fixture Git targeting/configuration.
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !/^GIT_/i.test(name)));
}
function git(root: string, ...args: string[]): string {
  // The test runner supplies Git on PATH; arguments operate only on isolated fixtures.
  // eslint-disable-next-line sonarjs/no-os-command-from-path
  const result = spawnSync('git', args, {
    cwd: root,
    env: isolatedEnvironment(),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function manifests(root: string, version: string, overrides: Record<string, unknown> = {}): void {
  const files = {
    'package.json': { name: 'example-package', version },
    'package-lock.json': {
      name: 'example-package',
      version,
      packages: { '': { name: 'example-package', version } },
    },
    'server.json': {
      name: 'io.github.example/project',
      version,
      packages: [{ registryType: 'npm', identifier: 'example-package', version }],
    },
    ...overrides,
  };
  for (const [name, data] of Object.entries(files))
    writeFileSync(path.join(root, name), JSON.stringify(data));
}
function project(version = '1.2.4', overrides: Record<string, unknown> = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'ohs-release-guard-'));
  cleanupTasks.push(() => rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'work');
  const remote = path.join(directory, 'origin.git');
  mkdirSync(root);
  git(directory, 'init', '--bare', remote);
  git(root, 'init', '-b', 'master');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'user.name', 'Release Test');
  git(root, 'remote', 'add', 'origin', remote);
  manifests(root, '1.2.3');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'Initial manifests');
  const parent = git(root, 'rev-parse', 'HEAD');
  manifests(root, version, overrides);
  git(root, 'add', '.');
  git(root, 'commit', '--allow-empty', '-m', 'Arbitrary subject: identity comes from the PR');
  const sha = git(root, 'rev-parse', 'HEAD');
  git(root, 'push', '-u', 'origin', 'master');
  return { root, remote, sha, parent };
}
function repositoryFiles(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  function readDirectory(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) readDirectory(filename);
      else files[path.relative(root, filename)] = readFileSync(filename).toString('base64');
    }
  }
  readDirectory(root);
  return files;
}
function sentinel() {
  const repo = project();
  git(repo.root, 'config', 'user.name', 'Sentinel Identity');
  git(repo.root, 'config', 'user.email', 'sentinel@example.invalid');
  writeFileSync(path.join(repo.root, 'sentinel.txt'), 'must remain unchanged\n');
  const gitDirectory = path.join(repo.root, '.git');
  return {
    ...repo,
    files: repositoryFiles(repo.root),
    hookEnvironment: {
      GIT_DIR: gitDirectory,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'user.name',
      GIT_CONFIG_VALUE_0: 'Hook Identity',
    },
    guardEnvironment: {
      GIT_DIR: gitDirectory,
      GIT_COMMON_DIR: gitDirectory,
      GIT_WORK_TREE: repo.root,
      GIT_INDEX_FILE: path.join(gitDirectory, 'index'),
      GIT_OBJECT_DIRECTORY: path.join(gitDirectory, 'objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(gitDirectory, 'objects'),
      GIT_CONFIG_GLOBAL: path.join(gitDirectory, 'config'),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'user.name',
      GIT_CONFIG_VALUE_0: 'Hook Identity',
      GIT_CONFIG_PARAMETERS: "'user.email=hook@example.invalid'",
    },
  };
}
function ciRun(sha: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 101,
    workflow_id: 17,
    name: 'CI',
    path: '.github/workflows/ci.yml',
    head_sha: sha,
    head_branch: 'master',
    head_repository: { full_name: REPOSITORY },
    repository: { full_name: REPOSITORY },
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    ...overrides,
  };
}
function dependencyPr(sha: string, overrides: Record<string, unknown> = {}) {
  return {
    number: 42,
    state: 'closed',
    merged_at: '2026-10-05T00:00:00Z',
    merge_commit_sha: sha,
    head: { ref: 'chore/update-deps', repo: { full_name: REPOSITORY } },
    base: { ref: 'master', repo: { full_name: REPOSITORY } },
    ...overrides,
  };
}
async function apiServer(handler: (url: URL) => { status?: number; data: unknown }) {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? '');
    const response = handler(new URL(req.url ?? '/', 'http://localhost'));
    res.writeHead(response.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(response.data));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanupTasks.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}`, requests };
}
async function githubApi(
  sha: string,
  options: {
    run?: Record<string, unknown>;
    prs?: unknown[];
    runs?: unknown[];
    status?: number;
  } = {},
) {
  return apiServer((url) => {
    if (options.status) return { status: options.status, data: { message: 'API unavailable' } };
    if (url.pathname.endsWith('/actions/workflows/ci.yml'))
      return { data: { id: 17, path: '.github/workflows/ci.yml' } };
    if (url.pathname.endsWith('/actions/runs/101')) return { data: options.run ?? ciRun(sha) };
    if (url.pathname.endsWith('/pulls')) return { data: options.prs ?? [dependencyPr(sha)] };
    if (
      url.pathname.endsWith('/actions/workflows/ci.yml/runs') &&
      url.searchParams.get('head_sha') === sha
    ) {
      return {
        data: {
          total_count: (options.runs ?? [ciRun(sha)]).length,
          workflow_runs: options.runs ?? [ciRun(sha)],
        },
      };
    }
    return { status: 500, data: { message: `Unexpected API request: ${url.pathname}` } };
  });
}
async function run(
  root: string,
  command: string,
  api: string,
  overrides: Record<string, string> = {},
  script = 'release-guard.mjs',
) {
  const eventPath = path.join(root, 'event.json');
  if (!existsSync(eventPath))
    writeFileSync(
      eventPath,
      JSON.stringify({ action: 'completed', workflow_run: ciRun(git(root, 'rev-parse', 'HEAD')) }),
    );
  const output = path.join(root, 'outputs');
  rmSync(output, { force: true });
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', script), command], {
    cwd: root,
    env: isolatedEnvironment({
      ...process.env,
      GITHUB_REPOSITORY: REPOSITORY,
      GITHUB_TOKEN: 'controlled-test-token',
      GITHUB_API_URL: api,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_OUTPUT: output,
      CANDIDATE_SHA: git(root, 'rev-parse', 'HEAD'),
      RELEASE_TAG: 'v1.2.4',
      MCP_REGISTRY_URL: api,
      ...overrides,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => (stdout += chunk));
  child.stderr.on('data', (chunk: string) => (stderr += chunk));
  const [status] = (await once(child, 'close')) as [number | null];
  return {
    status,
    stdout,
    stderr,
    outputs: existsSync(output) ? readFileSync(output, 'utf8') : '',
  };
}

describe('release guard at GitHub API and git boundaries', () => {
  it('keeps a hook-targeted sentinel repository unchanged while creating fixture repositories', () => {
    const guarded = sentinel();
    const originalGitEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => /^GIT_/i.test(name)),
    );
    Object.assign(process.env, guarded.hookEnvironment);
    try {
      const fixture = project();
      assert.equal(git(fixture.root, 'config', 'user.name'), 'Release Test');
      assert.equal(git(fixture.remote, 'config', 'core.bare'), 'true');
    } finally {
      for (const name of Object.keys(process.env))
        if (/^GIT_/i.test(name)) delete process.env[name];
      Object.assign(process.env, originalGitEnvironment);
      assert.deepEqual(
        repositoryFiles(guarded.root),
        guarded.files,
        'Sentinel config, refs, and files must remain unchanged',
      );
    }
  });
  it('isolates spawned tag and recovery guards from hook Git targeting and configuration', async () => {
    const guarded = sentinel();
    const fixture = project();
    const tagged = await run(fixture.root, 'tag', '', guarded.guardEnvironment);
    assert.equal(tagged.status, 0, tagged.stderr);
    assert.equal(git(fixture.remote, 'rev-parse', 'refs/tags/v1.2.4'), fixture.sha);
    const api = await githubApi(fixture.sha);
    const verified = await run(fixture.root, 'verify', api.url, guarded.guardEnvironment);
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal(verified.outputs, `release_tag=v1.2.4\ncommit_sha=${fixture.sha}\n`);
    assert.deepEqual(
      repositoryFiles(guarded.root),
      guarded.files,
      'Sentinel config, refs, and files must remain unchanged',
    );
  });
  it('selects the exact successful CI commit associated with a merged dependency PR', async () => {
    const repo = project();
    const api = await githubApi(repo.sha);
    const result = await run(repo.root, 'candidate', api.url, { GITHUB_SHA: OTHER_SHA });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.outputs, `candidate_sha=${repo.sha}\n`);
  });
  it.each([
    ['failed CI', { conclusion: 'failure' }],
    ['non-push CI', { event: 'pull_request' }],
    ['non-master CI', { head_branch: 'feature' }],
    ['fork CI', { head_repository: { full_name: 'attacker/project' } }],
  ])('skips %s without a release candidate', async (_name, overrides) => {
    const repo = project();
    const event = { action: 'completed', workflow_run: ciRun(repo.sha, overrides) };
    writeFileSync(path.join(repo.root, 'event.json'), JSON.stringify(event));
    const api = await githubApi(repo.sha);
    const result = await run(repo.root, 'candidate', api.url);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.outputs, '');
    assert.match(result.stdout, /Skipping/);
    assert.deepEqual(git(repo.remote, 'tag'), '');
  });
  it('rejects CI data that does not match the completion payload', async () => {
    const repo = project();
    const api = await githubApi(repo.sha, { run: ciRun(OTHER_SHA) });
    const result = await run(repo.root, 'candidate', api.url);
    assert.notEqual(result.status, 0);
    assert.equal(result.outputs, '');
  });
  it('rejects a dependency PR whose merge SHA differs from the checked commit', async () => {
    const repo = project();
    const api = await githubApi(repo.sha, { prs: [dependencyPr(OTHER_SHA)] });
    const result = await run(repo.root, 'candidate', api.url);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /merge.*SHA/i);
    assert.equal(result.outputs, '');
  });
  it.each([
    { merged_at: null },
    { head: { ref: 'chore/update-deps', repo: { full_name: 'attacker/project' } } },
    { base: { ref: 'other', repo: { full_name: REPOSITORY } } },
  ])('rejects invalid dependency PR provenance %#', async (overrides) => {
    const repo = project();
    const api = await githubApi(repo.sha, { prs: [dependencyPr(repo.sha, overrides)] });
    const result = await run(repo.root, 'candidate', api.url);
    assert.notEqual(result.status, 0);
    assert.equal(result.outputs, '');
  });
  it('skips unrelated master CI even when an unrelated PR has a release-like title', async () => {
    const repo = project();
    const api = await githubApi(repo.sha, {
      prs: [
        dependencyPr(repo.sha, {
          title: 'chore: weekly dependency update',
          head: { ref: 'fix/unrelated', repo: { full_name: REPOSITORY } },
        }),
      ],
    });
    const result = await run(repo.root, 'candidate', api.url);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.outputs, '');
    assert.match(result.stdout, /Skipping/);
  });
  it('fails closed when the GitHub API is unavailable', async () => {
    const repo = project();
    const api = await githubApi(repo.sha, { status: 503 });
    const result = await run(repo.root, 'candidate', api.url);
    assert.notEqual(result.status, 0);
    assert.equal(result.outputs, '');
    assert.match(result.stderr, /503/);
  });
  it('tags a synchronized exact patch candidate still in master history after a newer commit', async () => {
    const repo = project();
    writeFileSync(path.join(repo.root, 'newer.txt'), 'newer master commit');
    git(repo.root, 'add', 'newer.txt');
    git(repo.root, 'commit', '-m', 'Newer unrelated master commit');
    git(repo.root, 'push', 'origin', 'master');
    git(repo.root, 'checkout', '--detach', repo.sha);
    const result = await run(repo.root, 'tag', '', { CANDIDATE_SHA: repo.sha });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.outputs, `release_tag=v1.2.4\ncommit_sha=${repo.sha}\n`);
    assert.equal(git(repo.remote, 'rev-parse', 'refs/tags/v1.2.4'), repo.sha);
  });
  it.each(['1.2.3', '1.3.0', '2.0.0', '1.2.5'])(
    'rejects missing or non-patch bump %s without creating a tag',
    async (version) => {
      const repo = project(version);
      const result = await run(repo.root, 'tag', '');
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /patch/);
      assert.equal(git(repo.remote, 'tag'), '');
    },
  );
  it.each([
    { 'package-lock.json': { version: '1.2.3', packages: { '': { version: '1.2.4' } } } },
    { 'package-lock.json': { version: '1.2.4', packages: { '': { version: '1.2.3' } } } },
    {
      'server.json': {
        version: '1.2.3',
        packages: [{ registryType: 'npm', identifier: 'example-package', version: '1.2.4' }],
      },
    },
    {
      'server.json': {
        version: '1.2.4',
        packages: [{ registryType: 'npm', identifier: 'example-package', version: '1.2.3' }],
      },
    },
  ])('rejects unsynchronized release manifests %# before writing a tag', async (overrides) => {
    const repo = project('1.2.4', overrides);
    const result = await run(repo.root, 'tag', '');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /synchron/i);
    assert.equal(git(repo.remote, 'tag'), '');
  });
  it('rejects a candidate outside master history', async () => {
    const repo = project();
    git(repo.root, 'checkout', '-b', 'feature', repo.parent);
    manifests(repo.root, '1.2.4');
    git(repo.root, 'add', '.');
    git(repo.root, 'commit', '-m', 'Unmerged candidate');
    const result = await run(repo.root, 'tag', '');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /master/);
    assert.equal(git(repo.remote, 'tag'), '');
  });
  it('rejects changes outside the three manifests before tagging', async () => {
    const repo = project();
    writeFileSync(path.join(repo.root, 'release-policy.yml'), 'altered release policy');
    git(repo.root, 'add', '.');
    git(repo.root, 'commit', '--amend', '--no-edit');
    git(repo.root, 'push', '--force', 'origin', 'master');
    const result = await run(repo.root, 'tag', '');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /manifest|release-policy/);
    assert.equal(git(repo.remote, 'tag'), '');
  });
  it('reruns safely when the release tag already points to the candidate', async () => {
    const repo = project();
    const first = await run(repo.root, 'tag', '');
    const second = await run(repo.root, 'tag', '');
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(git(repo.remote, 'rev-parse', 'refs/tags/v1.2.4'), repo.sha);
    assert.match(second.stdout, /already/);
  });
  it('fails without moving an existing tag targeting a different commit', async () => {
    const repo = project();
    git(repo.root, 'tag', 'v1.2.4', repo.parent);
    git(repo.root, 'push', 'origin', 'refs/tags/v1.2.4');
    const result = await run(repo.root, 'tag', '');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /already.*different|conflict/i);
    assert.equal(git(repo.remote, 'rev-parse', 'refs/tags/v1.2.4'), repo.parent);
  });
  it('recovers the explicit older annotated tag instead of the moving master tip', async () => {
    const repo = project();
    git(repo.root, 'tag', '-a', 'v1.2.4', '-m', 'Release');
    git(repo.root, 'push', 'origin', 'refs/tags/v1.2.4');
    manifests(repo.root, '1.2.5');
    git(repo.root, 'add', '.');
    git(repo.root, 'commit', '-m', 'Newer version');
    git(repo.root, 'push', 'origin', 'master');
    const api = await githubApi(repo.sha);
    const result = await run(repo.root, 'verify', api.url, { GITHUB_SHA: OTHER_SHA });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.outputs, `release_tag=v1.2.4\ncommit_sha=${repo.sha}\n`);
  });
  it.each([
    ['different SHA', { head_sha: OTHER_SHA }],
    ['failed CI', { conclusion: 'failure' }],
    ['PR CI', { event: 'pull_request' }],
    ['non-master CI', { head_branch: 'feature' }],
    ['fork CI', { head_repository: { full_name: 'attacker/project' } }],
    ['another workflow', { workflow_id: 99 }],
    ['incomplete CI', { status: 'in_progress', conclusion: null }],
  ])('refuses publication authorized only by %s', async (_name, overrides) => {
    const repo = project();
    git(repo.root, 'tag', 'v1.2.4');
    git(repo.root, 'push', 'origin', 'refs/tags/v1.2.4');
    const api = await githubApi(repo.sha, { runs: [ciRun(repo.sha, overrides)] });
    const result = await run(repo.root, 'verify', api.url);
    assert.notEqual(result.status, 0);
    assert.equal(result.outputs, '');
    assert.match(result.stderr, /re-run|rerun/i);
  });
  it('permits explicit recovery with same-repository master dispatch CI for the exact tag SHA', async () => {
    const repo = project();
    git(repo.root, 'tag', 'v1.2.4');
    git(repo.root, 'push', 'origin', 'refs/tags/v1.2.4');
    const api = await githubApi(repo.sha, {
      runs: [ciRun(repo.sha, { event: 'workflow_dispatch' })],
    });
    const result = await run(repo.root, 'verify', api.url);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.outputs, `release_tag=v1.2.4\ncommit_sha=${repo.sha}\n`);
  });
  it('rejects a tag that disagrees with the resolved package version', async () => {
    const repo = project();
    git(repo.root, 'tag', 'v9.9.9');
    git(repo.root, 'push', 'origin', 'refs/tags/v9.9.9');
    const api = await githubApi(repo.sha);
    const result = await run(repo.root, 'verify', api.url, { RELEASE_TAG: 'v9.9.9' });
    assert.notEqual(result.status, 0);
    assert.equal(result.outputs, '');
    assert.match(result.stderr, /version/);
  });
  it('rejects malformed tag inputs instead of evaluating git revision syntax', async () => {
    const repo = project();
    const result = await run(repo.root, 'verify', '', { RELEASE_TAG: 'master^{commit}' });
    assert.notEqual(result.status, 0);
    assert.equal(result.outputs, '');
    assert.match(result.stderr, /tag/);
  });
});

describe('MCP Registry recovery at HTTP and publisher process boundaries', () => {
  function publisher(root: string, exitCode = 0) {
    const script = path.join(root, 'fake-publisher.mjs');
    const log = path.join(root, 'publisher.jsonl');
    writeFileSync(
      script,
      `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nprocess.exit(${exitCode});\n`,
    );
    return {
      env: { MCP_PUBLISHER_PATH: process.execPath, MCP_PUBLISHER_ARGS: JSON.stringify([script]) },
      log,
    };
  }
  function calls(log: string): string[][] {
    return existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as string[])
      : [];
  }
  it('skips an already-published identical active server version', async () => {
    const repo = project();
    const processFixture = publisher(repo.root);
    const api = await apiServer(() => ({
      data: {
        server: {
          name: 'io.github.example/project',
          version: '1.2.4',
          packages: [{ registryType: 'npm', identifier: 'example-package', version: '1.2.4' }],
        },
        _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active' } },
      },
    }));
    const result = await run(repo.root, '', api.url, processFixture.env, 'publish-release-mcp.mjs');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /already published/);
    assert.deepEqual(calls(processFixture.log), []);
    assert.deepEqual(api.requests, [
      '/v0.1/servers/io.github.example%2Fproject/versions/1.2.4?include_deleted=true',
    ]);
  });
  it('authenticates and publishes a missing server version', async () => {
    const repo = project();
    const processFixture = publisher(repo.root);
    const api = await apiServer(() => ({ status: 404, data: { title: 'Not found' } }));
    const result = await run(repo.root, '', api.url, processFixture.env, 'publish-release-mcp.mjs');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(calls(processFixture.log), [['login', 'github-oidc'], ['publish']]);
  });
  it('fails closed on an unexpected registry error', async () => {
    const repo = project();
    const processFixture = publisher(repo.root);
    const api = await apiServer(() => ({ status: 503, data: { title: 'Unavailable' } }));
    const result = await run(repo.root, '', api.url, processFixture.env, 'publish-release-mcp.mjs');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /503/);
    assert.deepEqual(calls(processFixture.log), []);
  });
  it('rejects an existing conflicting server record rather than claiming recovery success', async () => {
    const repo = project();
    const processFixture = publisher(repo.root);
    const api = await apiServer(() => ({
      data: {
        server: {
          name: 'io.github.example/project',
          version: '1.2.4',
          packages: [{ registryType: 'npm', identifier: 'other-package', version: '1.2.4' }],
        },
        _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active' } },
      },
    }));
    const result = await run(repo.root, '', api.url, processFixture.env, 'publish-release-mcp.mjs');
    assert.notEqual(result.status, 0);
    assert.deepEqual(calls(processFixture.log), []);
  });
  it('propagates publisher authentication failure and never attempts publication', async () => {
    const repo = project();
    const processFixture = publisher(repo.root, 23);
    const api = await apiServer(() => ({ status: 404, data: { title: 'Not found' } }));
    const result = await run(repo.root, '', api.url, processFixture.env, 'publish-release-mcp.mjs');
    assert.equal(result.status, 23);
    assert.deepEqual(calls(processFixture.log), [['login', 'github-oidc']]);
  });
  it('rejects malformed publisher argument configuration before starting a process', async () => {
    const repo = project();
    const processFixture = publisher(repo.root);
    const api = await apiServer(() => ({ status: 404, data: { title: 'Not found' } }));
    const result = await run(
      repo.root,
      '',
      api.url,
      { ...processFixture.env, MCP_PUBLISHER_ARGS: '"not-an-array"' },
      'publish-release-mcp.mjs',
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /MCP_PUBLISHER_ARGS.*array/);
    assert.deepEqual(calls(processFixture.log), []);
  });
});
