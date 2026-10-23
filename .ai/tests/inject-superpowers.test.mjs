import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('bootstrap loads its checkout skill from a subdirectory with no Git on PATH', () => {
  const env = { ...process.env, PATH: '' };
  delete env.CLAUDE_PROJECT_DIR;
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('../hooks/inject-superpowers.mjs', import.meta.url))],
    {
      cwd: fileURLToPath(new URL('../skills', import.meta.url)),
      env,
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  const skill = readFileSync(
    new URL('../skills/using-superpowers/SKILL.md', import.meta.url),
    'utf8',
  );
  assert.ok(context.includes(skill), 'the hook injects the real skill regardless of cwd and PATH');
});
