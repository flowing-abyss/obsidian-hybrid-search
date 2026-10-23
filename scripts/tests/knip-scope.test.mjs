import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const knip = path.join(repository, 'node_modules/knip/bin/knip.js');

test('Knip analyzes utility tests while excluding a populated independent submodule', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'ohs-knip-scope-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (relative, content) => {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  write('knip.json', readFileSync(path.join(repository, 'knip.json')));
  write('.gitignore', readFileSync(path.join(repository, '.gitignore')));
  write(
    'package.json',
    JSON.stringify({
      name: 'scope-fixture',
      version: '1.0.0',
      type: 'module',
      scripts: { 'test:tooling': 'node --test scripts/tests/*.test.mjs' },
    }),
  );
  write('src/server.ts', 'export const onlyUsedBySubmodule = 1;\n');
  write('scripts/tests/owned.test.mjs', 'import "missing-owned-dependency";\n');
  write('obsidian-plugin/package.json', '{"name":"independent-plugin","version":"1.0.0"}\n');
  write(
    'obsidian-plugin/test/plugin.test.ts',
    'import "obsidian"; import { onlyUsedBySubmodule } from "../../src/server.js"; console.log(onlyUsedBySubmodule);\n',
  );
  const analyze = () => {
    const result = spawnSync(process.execPath, [knip, '--reporter', 'json'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stderr, '', 'configuration must work without hints or warnings');
    const report = JSON.parse(result.stdout);
    assert.ok(report.issues.every((issue) => !issue.file.startsWith('obsidian-plugin/')));
    const ownTest = report.issues.find((issue) => issue.file === 'scripts/tests/owned.test.mjs');
    assert.deepEqual(
      ownTest.unlisted.map((item) => item.name),
      ['missing-owned-dependency'],
    );
    const source = report.issues.find((issue) => issue.file === 'src/server.ts');
    assert.deepEqual(
      source.exports.map((item) => item.name),
      ['onlyUsedBySubmodule'],
    );
  };
  analyze();
  // A normal non-recursive clone has an empty submodule directory.
  rmSync(path.join(root, 'obsidian-plugin'), { recursive: true });
  mkdirSync(path.join(root, 'obsidian-plugin'));
  analyze();
});
