#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ai = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(ai);
const require = createRequire(import.meta.url);
const localHusky = path.join(root, 'node_modules/husky/index.js');
const husky = existsSync(localHusky)
  ? path.join(path.dirname(require.resolve('husky')), 'bin.js')
  : '';
const scripts = [
  existsSync(husky) && husky,
  path.join(ai, 'setup.mjs'),
  path.join(ai, 'setup-codegraph.mjs'),
].filter(Boolean);
for (const script of scripts) {
  // npm 12 streams lifecycle stdout even for pack --json. Keep diagnostics visible
  // on stderr so machine-readable npm output remains parseable.
  const result = spawnSync(process.execPath, [script], { cwd: root, stdio: ['inherit', 2, 2] });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}
