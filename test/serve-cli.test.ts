import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CLI_TIMEOUT_MS = 5_000;
const CLI_KILL_GRACE_MS = 500;

let vaultDir: string;
let cliRoot: string;

interface CliResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function cliArgs(args: string[]): string[] {
  return [
    '--preserve-symlinks',
    '--preserve-symlinks-main',
    '--import',
    'tsx',
    path.join(cliRoot, 'dist/src/cli.ts'),
    ...args,
  ];
}

function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, cliArgs(args), {
      cwd: ROOT,
      env: { ...process.env, OBSIDIAN_VAULT_PATH: vaultDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, CLI_KILL_GRACE_MS);
    }, CLI_TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      clearTimeout(timeout);
      if (killTimer !== undefined) clearTimeout(killTimer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (timedOut) {
        reject(
          new Error(`CLI timed out: ${args.join(' ')}\nstdout:\n${stdout}\nstderr:\n${stderr}`),
        );
        return;
      }
      resolve({ stdout, stderr, code });
    });
  });
}

beforeEach(() => {
  vaultDir = mkdtempSync(path.join(tmpdir(), 'ohs-serve-cli-test-'));
  writeFileSync(path.join(vaultDir, 'alpha.md'), '# Alpha\n\nSmoke test note.\n');

  cliRoot = mkdtempSync(path.join(tmpdir(), 'ohs-serve-cli-source-'));
  mkdirSync(path.join(cliRoot, 'dist'));
  symlinkSync(path.join(ROOT, 'src'), path.join(cliRoot, 'dist/src'), 'dir');
  symlinkSync(path.join(ROOT, 'package.json'), path.join(cliRoot, 'package.json'));
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(cliRoot, 'node_modules'), 'dir');
  symlinkSync(path.join(ROOT, 'tsconfig.json'), path.join(cliRoot, 'tsconfig.json'));
});

afterEach(() => {
  rmSync(vaultDir, { recursive: true, force: true });
  rmSync(cliRoot, { recursive: true, force: true });
});

describe('serve CLI smoke tests', () => {
  it('rejects a non-numeric HTTP port', async () => {
    const result = await runCli(['serve', '--port', 'not-a-number']);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /invalid port|--port must be an integer/i);
  });

  it('rejects stdio and HTTP mode together', async () => {
    const result = await runCli(['serve', '--stdio', '--http']);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /--stdio cannot be combined|--stdio is mutually exclusive/i);
  });

  it('reports that the HTTP MCP server is not running', async () => {
    const result = await runCli(['serve', 'status']);

    assert.equal(result.code, 0);
    assert.match(result.stdout, /not running/i);
  });

  it('rejects management commands combined with serve transport options', async () => {
    const result = await runCli(['serve', '--stdio', 'status']);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /serve status cannot be combined|cannot be combined/i);
  });
});
