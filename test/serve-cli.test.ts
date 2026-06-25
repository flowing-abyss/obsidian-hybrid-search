import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

function runCli(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, cliArgs(args), {
      cwd: ROOT,
      env: {
        ...process.env,
        OBSIDIAN_VAULT_PATH: vaultDir,
        XDG_CACHE_HOME: path.join(cliRoot, 'cache'),
        ...env,
      },
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

function assertNoVaultDbFiles(): void {
  for (const filename of [
    '.obsidian-hybrid-search.db',
    '.obsidian-hybrid-search.db-wal',
    '.obsidian-hybrid-search.db-shm',
  ]) {
    assert.equal(existsSync(path.join(vaultDir, filename)), false, `${filename} should not exist`);
  }
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
  it('exposes a registry-friendly MCP stdio command', async () => {
    const result = await runCli(['mcp', '--help']);

    assert.equal(result.code, 0);
    assert.match(result.stdout, /Start the MCP server over stdio/);
    assertNoVaultDbFiles();
  });

  it('rejects a non-numeric search limit', async () => {
    const result = await runCli(['alpha', '--limit', 'abc']);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Invalid --limit/i);
    assertNoVaultDbFiles();
  });

  it('rejects an unsupported related link type', async () => {
    const result = await runCli(['alpha.md', '--related', '--link-type', 'url']);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Invalid --link-type/i);
    assertNoVaultDbFiles();
  });

  it('rejects a non-numeric read snippet length', async () => {
    const result = await runCli(['read', 'alpha.md', '--snippet-length', 'abc']);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Invalid --snippet-length/i);
    assertNoVaultDbFiles();
  });

  it('rejects a non-numeric HTTP port', async () => {
    const result = await runCli(['serve', '--port', 'not-a-number']);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /invalid port|--port must be an integer/i);
  });

  it('accepts repeated allowed-host options before validating the HTTP port', async () => {
    const result = await runCli([
      'serve',
      '--allowed-host',
      '100.81.189.83:3939',
      '--allowed-host',
      'laptop.tailnet.ts.net:3939',
      '--foreground',
      '--port',
      'not-a-number',
    ]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /invalid port|--port must be an integer/i);
  });

  it('accepts OBSIDIAN_MCP_ALLOWED_HOSTS before validating the HTTP port', async () => {
    const result = await runCli(['serve', '--port', 'not-a-number'], {
      OBSIDIAN_MCP_ALLOWED_HOSTS: '100.81.189.83:3939, laptop.tailnet.ts.net:3939',
    });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /invalid port|--port must be an integer/i);
  });

  it('rejects stdio and HTTP mode together', async () => {
    const result = await runCli(['serve', '--stdio', '--http']);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /--stdio cannot be combined|--stdio is mutually exclusive/i);
  });

  it('rejects stdio combined with allowed-host', async () => {
    const result = await runCli(['serve', '--stdio', '--allowed-host', '100.81.189.83:3939']);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /--stdio cannot be combined|--stdio is mutually exclusive/i);
  });

  it('rejects stdio combined with allow-any-host', async () => {
    const result = await runCli(['serve', '--stdio', '--allow-any-host']);

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

  it('rejects management commands combined with allowed-host', async () => {
    const result = await runCli(['serve', '--allowed-host', '100.81.189.83:3939', 'status']);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /serve status cannot be combined|cannot be combined/i);
  });

  it('rejects management commands combined with allow-any-host', async () => {
    const result = await runCli(['serve', '--allow-any-host', 'status']);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /serve status cannot be combined|cannot be combined/i);
  });

  it('rejects stop combined with allowed-host', async () => {
    const result = await runCli(['serve', '--allowed-host', '100.81.189.83:3939', 'stop']);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /serve stop cannot be combined|cannot be combined/i);
  });

  it('rejects stop combined with allow-any-host', async () => {
    const result = await runCli(['serve', '--allow-any-host', 'stop']);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /serve stop cannot be combined|cannot be combined/i);
  });
});
