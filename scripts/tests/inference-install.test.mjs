import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const checker = new URL('../check-inference-install.mjs', import.meta.url);

function checkInstall(t, moduleSource) {
  const root = mkdtempSync(path.join(tmpdir(), 'ohs-inference-install-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, 'check-inference-install.mjs');
  if (existsSync(checker)) copyFileSync(checker, script);
  if (moduleSource !== undefined) {
    const dependency = path.join(root, 'node_modules', '@huggingface', 'transformers');
    mkdirSync(dependency, { recursive: true });
    writeFileSync(
      path.join(dependency, 'package.json'),
      JSON.stringify({ name: '@huggingface/transformers', type: 'module', exports: './index.js' }),
    );
    writeFileSync(path.join(dependency, 'index.js'), moduleSource);
  }
  // The caller has real dependencies; resolution must still belong to the checked checkout.
  return spawnSync(process.execPath, [script], { encoding: 'utf8' });
}

test('missing optional inference dependency fails with installation guidance', (t) => {
  const result = checkInstall(t);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /@huggingface\/transformers/);
  assert.match(result.stderr, /npm ci --foreground-scripts/);
  assert.match(result.stderr, /ERR_MODULE_NOT_FOUND/);
});

test('present inference package must load successfully, preserving native failure diagnostics', (t) => {
  const result = checkInstall(t, "throw new Error('native fixture: shared library unavailable');");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /native fixture: shared library unavailable/);
  assert.match(result.stderr, /npm ci --foreground-scripts/);
});

test('healthy inference dependency is imported without downloading a model', (t) => {
  const result = checkInstall(t, "console.log('inference fixture evaluated');");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /inference fixture evaluated/);
  assert.equal(result.stderr, '');
});
