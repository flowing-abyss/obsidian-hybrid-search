import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function writeFixtureFile(file: string, content: string): void {
  let descriptor: number;
  try {
    // Git marks .git files hidden on Windows; opening them with 'w' fails with EPERM.
    descriptor = openSync(file, 'r+');
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    writeFileSync(file, content);
    return;
  }
  try {
    ftruncateSync(descriptor, 0);
    writeFileSync(descriptor, content);
  } finally {
    closeSync(descriptor);
  }
}

export function createGitFixture(options: { linked?: boolean; vaultPrefix?: string } = {}) {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'ohs-git-fixture-')));
  const emptyConfig = path.join(root, 'empty-config');
  writeFileSync(emptyConfig, '');
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
  );
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig });
  let repo = path.join(root, 'Café repository');
  mkdirSync(repo);
  const run = (args: string[], cwd = repo) =>
    // Git is the independent test oracle, resolved from the runner's PATH.
    // eslint-disable-next-line sonarjs/no-os-command-from-path
    spawnSync('git', ['-c', 'core.excludesFile=' + emptyConfig, ...args], {
      cwd,
      env,
      encoding: 'utf8',
    });
  const git = (args: string[], cwd = repo): string => {
    const result = run(args, cwd);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trimEnd();
  };
  git(['init', '--quiet']);
  if (options.linked) {
    git([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgSign=false',
      'commit',
      '--allow-empty',
      '-qm',
      'fixture',
    ]);
    const linked = path.join(root, 'linked worktree');
    git(['worktree', 'add', '--detach', '--quiet', linked]);
    repo = linked;
  }
  repo = realpathSync.native(repo);
  const vault = path.join(repo, options.vaultPrefix ?? '');
  mkdirSync(vault, { recursive: true });
  const commonDir = realpathSync.native(
    git(['rev-parse', '--path-format=absolute', '--git-common-dir']),
  );
  return {
    root,
    repo,
    vault,
    commonDir,
    exclude: realpathSync.native(
      git(['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude']),
    ),
    git,
    ignored(relativePath: string): boolean {
      const result = run(
        ['check-ignore', '--no-index', '--quiet', '--', relativePath.replace(/\/$/, '')],
        vault,
      );
      assert.ok(result.status === 0 || result.status === 1, result.stderr);
      return result.status === 0;
    },
    write(relativeRepoPath: string, content: string): void {
      const file = path.join(repo, relativeRepoPath);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFixtureFile(file, content);
    },
    dispose(): void {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
