import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { it, vi } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(root, 'dist/src/cli.js');
const preload = new URL('../dist/test/fixtures/download-progress-preload.js', import.meta.url).href;

it.each([
  { name: 'interactive search', args: ['search', 'links'], visible: true },
  { name: 'JSON search', args: ['search', 'links', '--json'], visible: false },
  { name: 'path output', args: ['search', 'links', '--only-paths'], visible: false },
  { name: 'absolute paths', args: ['search', 'links', '--only-absolute-paths'], visible: false },
  { name: 'file reindex JSON', args: ['reindex', 'note.md'], visible: false },
  { name: 'pipe', args: ['search', 'links'], visible: false, pipe: true },
])('keeps model download output appropriate for $name', ({ args, visible, pipe }) => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'ohs-cli-progress-'));
  try {
    fs.writeFileSync(path.join(vault, 'note.md'), '# Links\nInternal links connect notes.');
    const result = spawnSync(process.execPath, ['--import', preload, cli, ...args], {
      cwd: root,
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        OBSIDIAN_VAULT_PATH: vault,
        OPENAI_API_KEY: '',
        OPENAI_BASE_URL: '',
        OPENAI_EMBEDDING_MODEL: '',
        LOCAL_EMBEDDING_MODEL: 'Xenova/multilingual-e5-small',
        OHS_TEST_PIPE: pipe ? '1' : '0',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr.includes('Downloading embedding model'), visible, result.stderr);
    assert.ok(!result.stdout.includes('Downloading'));
    if (args.includes('--json') || args[0] === 'reindex') JSON.parse(result.stdout);
    if (visible) assert.ok(result.stderr.endsWith('\r\x1b[2K'));
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

it('keeps CLI MCP responses valid and model downloads silent even with terminal flags enabled', async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'ohs-mcp-progress-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', preload, cli, 'mcp'],
    cwd: root,
    stderr: 'pipe',
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      OBSIDIAN_VAULT_PATH: vault,
      OPENAI_API_KEY: '',
      OPENAI_BASE_URL: '',
      OPENAI_EMBEDDING_MODEL: '',
      LOCAL_EMBEDDING_MODEL: 'Xenova/multilingual-e5-small',
      RERANKER_MODEL: 'test/progress-reranker',
      OHS_TEST_PIPE: '0',
    },
  });
  const client = new Client({ name: 'progress-test', version: '1.0.0' });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  try {
    for (const name of ['alpha', 'beta', 'gamma']) {
      fs.writeFileSync(path.join(vault, `${name}.md`), `# ${name}\nInternal links connect notes.`);
    }
    await client.connect(transport, { timeout: 5000 });
    // MCP accepts requests before its initial background indexing has finished.
    await vi.waitFor(
      async () => {
        const status = await client.callTool({ name: 'status', arguments: {} }, undefined, {
          timeout: 2000,
        });
        assert.ok(!status.isError);
        const content = status.content as Array<{ type: string; text?: string }>;
        const payload = JSON.parse(content[0]?.text ?? '') as { indexed: number };
        assert.equal(payload.indexed, 3);
      },
      { timeout: 5000, interval: 50 },
    );
    const response = await client.callTool(
      {
        name: 'search',
        arguments: { query: 'internal links', rerank: true, limit: 3 },
      },
      undefined,
      { timeout: 5000 },
    );
    assert.ok(!response.isError);
    const content = response.content as Array<{ type: string; text?: string }>;
    const payload = JSON.parse(content[0]?.text ?? '') as { results: Array<{ score: number }> };
    assert.equal(payload.results.length, 3);
    assert.ok(payload.results.every((result) => Number.isFinite(result.score)));
  } finally {
    try {
      await client.close();
    } finally {
      fs.rmSync(vault, { recursive: true, force: true });
    }
  }
  assert.ok(!stderr.includes('Downloading'), stderr);
}, 15_000);
