#!/usr/bin/env node
// Builds or refreshes this checkout's own CodeGraph index — `.codegraph/` at
// the checkout root, gitignored. Runs from `prepare`, so every `npm ci`
// covers it: a fresh clone, the main checkout, and each new worktree (Step 2
// of `using-git-worktrees` installs dependencies there). Re-run by hand with:
//
//   npm run codegraph:setup
//
// Every checkout owns its index. Never copy or symlink another checkout's
// `.codegraph/`: CodeGraph resolves the nearest `.codegraph/` walking up, so a
// worktree nested under `.worktrees/` without its own index would silently
// answer from the main checkout's code.
//
// Checks the local `codegraph.db` file rather than `codegraph status` for the
// same reason — status can report a parent checkout's index. `init --yes`
// builds a missing index without prompts; an existing one (including one left
// by an interrupted init) needs `sync`.
//
// Best effort: indexing is an agent convenience, not part of the build, so a
// failure warns and still exits 0 instead of failing `npm ci`. Skipped in
// CI, where no agent reads the index.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const aiRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(aiRoot, '..');
const launcher = path.join(aiRoot, 'codegraph.mjs');
const database = path.join(repoRoot, '.codegraph', 'codegraph.db');

if (process.env.CI) {
  console.log('codegraph: skipped in CI');
  process.exit(0);
}

const ready =
  (existsSync(database) || codegraph('init', '--yes', repoRoot)) &&
  existsSync(database) &&
  codegraph('sync', '--quiet', repoRoot);

if (!ready) {
  console.warn(
    'codegraph: setup failed — agents fall back to Read/Search in this checkout. ' +
      'Retry with `npm run codegraph:setup`.',
  );
}

function codegraph(...args) {
  const result = spawnSync(process.execPath, [launcher, ...args], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  return result.status === 0;
}
