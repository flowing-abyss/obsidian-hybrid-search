#!/usr/bin/env node
// npm install builds or refreshes this checkout's own .codegraph index.
// Check the local database directly: CodeGraph discovery can select a parent
// checkout's index. Indexing is optional for builds and is skipped in CI;
// after a failure, agents use file reads until npm run codegraph:setup succeeds.

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const aiRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(aiRoot, '..');
const launcher = path.join(aiRoot, 'codegraph.mjs');
const directory = path.join(repoRoot, '.codegraph');
const database = path.join(directory, 'codegraph.db');

if (process.env.CI) {
  console.log('codegraph: skipped in CI');
  process.exit(0);
}

// A full rebuild repairs interrupted indexes; incremental sync preserves incomplete metadata.
const ready =
  ownsIndex() &&
  (existsSync(database)
    ? codegraph('index', '--quiet', repoRoot)
    : codegraph('init', '--yes', repoRoot)) &&
  existsSync(database);

if (!ready) {
  console.warn(
    'codegraph: setup failed — agents fall back to Read/Search in this checkout. ' +
      'Retry with `npm run codegraph:setup`.',
  );
}

function ownsIndex() {
  try {
    const dir = lstatSync(directory, { throwIfNoEntry: false });
    const file = lstatSync(database, { throwIfNoEntry: false });
    return (!dir || dir.isDirectory()) && (!file || (file.isFile() && file.nlink === 1));
  } catch {
    return false;
  }
}

function codegraph(...args) {
  const result = spawnSync(process.execPath, [launcher, ...args], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  return result.status === 0;
}
