import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, it } from 'vitest';

const cli = fileURLToPath(new URL('../dist/src/cli.js', import.meta.url));
const registryUrl = 'https://registry.npmjs.org/obsidian-hybrid-search/latest';
const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };
let vault: string;
let preload: string;
let calls: string;

beforeEach(() => {
  vault = mkdtempSync(path.join(tmpdir(), 'ohs-cli-updates-'));
  preload = path.join(vault, 'fetch-preload.mjs');
  calls = path.join(vault, 'fetch-calls.log');
  writeFileSync(
    preload,
    `import { appendFileSync } from 'node:fs';
globalThis.fetch = (input) => {
  appendFileSync(process.env.OHS_TEST_UPDATE_CALLS, String(input) + '\\n');
  if (!process.env.OHS_TEST_UPDATE_VERSION) throw new Error('Fetch tripwire');
  return Promise.resolve(Response.json({ version: process.env.OHS_TEST_UPDATE_VERSION }));
};
`,
  );
});

afterEach(() => rmSync(vault, { recursive: true, force: true }));

function runStatus(checkForUpdates?: string, latestVersion?: string): Record<string, unknown> {
  const result = spawnSync(
    process.execPath,
    ['--import', pathToFileURL(preload).href, cli, 'status'],
    {
      cwd: vault,
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        OBSIDIAN_VAULT_PATH: vault,
        OBSIDIAN_CHECK_FOR_UPDATES: checkForUpdates,
        OHS_TEST_UPDATE_CALLS: calls,
        OHS_TEST_UPDATE_VERSION: latestVersion,
        XDG_CACHE_HOME: path.join(vault, 'cache'),
        OPENAI_API_KEY: '',
        OPENAI_BASE_URL: '',
        OPENAI_EMBEDDING_MODEL: '',
        LOCAL_EMBEDDING_MODEL: 'Xenova/multilingual-e5-small',
      },
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

it.each(['false', '0', 'no', ' NO '])(
  'status honors update-check opt-out %s without invoking fetch',
  (value) => {
    const status = runStatus(value);
    assert.equal(status.version_check, 'disabled');
    assert.equal(status.version, version);
    assert.equal(status.total, 0);
    assert.equal(existsSync(calls), false);
  },
);

it('status preserves the normal update notice with the default check enabled', () => {
  const status = runStatus(undefined, '999.0.0');
  assert.equal(status.latest_version, '999.0.0');
  assert.equal(status.update_command, 'npm install -g obsidian-hybrid-search');
  assert.equal(status.version_check, undefined);
  assert.equal(readFileSync(calls, 'utf8'), `${registryUrl}\n`);
});

it('status preserves the up-to-date result when checks are explicitly enabled', () => {
  const status = runStatus('true', version);
  assert.equal(status.latest_version, undefined);
  assert.equal(status.version_check, undefined);
  assert.equal(readFileSync(calls, 'utf8'), `${registryUrl}\n`);
});

it('status reports offline when an enabled check fails', () => {
  const status = runStatus('true');
  assert.equal(status.version_check, 'offline');
  assert.equal(readFileSync(calls, 'utf8'), `${registryUrl}\n`);
});
