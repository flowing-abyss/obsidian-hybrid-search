import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '..');
const gateScript = resolve(repoRoot, 'scripts/should-run-eval-quality.sh');
const bashPath =
  process.platform === 'win32'
    ? (['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'].find(
        existsSync,
      ) ?? 'C:\\Program Files\\Git\\bin\\bash.exe')
    : '/bin/bash';

function runGate(changedFiles: string[]) {
  return spawnSync(bashPath, [gateScript], {
    cwd: repoRoot,
    env: {
      ...process.env,
      OHS_PRE_PUSH_CHANGED_FILES: changedFiles.join('\n'),
    },
    encoding: 'utf8',
  });
}

describe('pre-push eval quality gate', () => {
  it('skips eval quality for README-only changes', () => {
    const result = runGate(['README.md']);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Skipping eval:quality');
  });

  it('runs eval quality for code changes', () => {
    const result = runGate(['src/searcher.ts']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Running eval:quality');
  });

  it('runs eval quality for fixture markdown changes', () => {
    const result = runGate(['test/fixtures/vault/notes/pkm/zettelkasten.md']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Running eval:quality');
  });
});
