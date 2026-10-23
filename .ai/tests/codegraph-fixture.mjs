import { copyFileSync, linkSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
export const aiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const platformName = `@colbymchenry/codegraph-${process.platform}-${process.arch}`;
export function checkout(t, beforeRemove = () => {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'codegraph-isolation-'));
  t.after(async () => {
    await beforeRemove(root);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  mkdirSync(path.join(root, '.ai'), { recursive: true });
  copyFileSync(path.join(aiRoot, 'codegraph.mjs'), path.join(root, '.ai/codegraph.mjs'));
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ type: 'module', devDependencies: { '@colbymchenry/codegraph': '1.6.2' } }),
  );
  return root;
}
export function mainPackage(root, version = '1.6.2') {
  const dir = path.join(root, 'node_modules/@colbymchenry/codegraph');
  mkdirSync(dir, { recursive: true });
  copyFileSync(
    path.join(aiRoot, '../node_modules/@colbymchenry/codegraph/npm-shim.js'),
    path.join(dir, 'npm-shim.js'),
  );
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ version, bin: { codegraph: 'npm-shim.js' } }),
  );
}
export function nativePackage(
  root,
  script = "console.log('LOCAL PLATFORM1.6.2');",
  version = '1.6.2',
  directory = path.join(root, 'node_modules', platformName),
) {
  mkdirSync(path.join(directory, 'lib/dist/bin'), { recursive: true });
  mkdirSync(path.join(directory, 'bin'), { recursive: true });
  writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({ name: platformName, version }),
  );
  const runtime = path.join(directory, process.platform === 'win32' ? 'node.exe' : 'node');
  const runtimeSource = path.join(
    aiRoot,
    '../node_modules',
    platformName,
    process.platform === 'win32' ? 'node.exe' : 'node',
  );
  try {
    linkSync(runtimeSource, runtime);
  } catch {
    copyFileSync(runtimeSource, runtime);
  }
  writeFileSync(path.join(directory, 'lib/dist/bin/codegraph.js'), script);
  writeFileSync(
    path.join(directory, 'bin/codegraph'),
    '#!/bin/sh\nexec "$(dirname "$0")/../node" --liftoff-only --disable-warning=ExperimentalWarning "$(dirname "$0")/../lib/dist/bin/codegraph.js" "$@"\n',
    { mode: 0o755 },
  );
  return directory;
}
export function index(root) {
  mkdirSync(path.join(root, '.codegraph'), { recursive: true });
  const db = new DatabaseSync(path.join(root, '.codegraph/codegraph.db'));
  db.exec(
    "CREATE TABLE nodes(id TEXT PRIMARY KEY); CREATE TABLE project_metadata(key TEXT PRIMARY KEY,value TEXT); INSERT INTO project_metadata VALUES ('index_state','complete')",
  );
  db.close();
}
