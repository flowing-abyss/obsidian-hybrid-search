import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, expect, it } from 'vitest';
import type { SearchOptions, SearchResult } from '../src/search/searcher.js';
import { handleStdioLine } from '../src/transports/stdio-server.js';

const root = path.resolve(import.meta.dirname, '..');
const vault = mkdtempSync(path.join(tmpdir(), 'ohs-transport-parity-'));
process.env.OBSIDIAN_VAULT_PATH = vault;
const {
  openDb,
  closeDb,
  initVecTable,
  upsertNote,
  upsertLinks,
  upsertMarkdownLinks,
  upsertNoteUrls,
} = await import('../src/storage/db.js');
const { search } = await import('../src/search/searcher.js');
const { populateMissingLinks, populateMissingMarkdownReferences } =
  await import('../src/indexing/indexer.js');
afterAll(() => {
  closeDb();
  rmSync(vault, { recursive: true, force: true });
});

it('CLI JSON, MCP and line IPC preserve the same filtered Unicode result contract', async () => {
  openDb();
  initVecTable(4);
  const content =
    '# Alpha\nalpha café body with enough context for the matching anchor. [[target]] [target](target.md) https://example.com/a';
  for (const [name, tags] of [
    ['café/alpha.md', ['café', 'active']],
    ['café/excluded.md', ['café', 'blocked']],
    ['target.md', []],
  ] as const) {
    const normalized = name.normalize('NFD');
    mkdirSync(path.dirname(path.join(vault, normalized)), { recursive: true });
    writeFileSync(path.join(vault, normalized), content);
    upsertNote({
      path: normalized,
      title: name,
      tags: [...tags],
      aliases: ['identity'],
      frontmatter: { state: 'open' },
      content,
      mtime: 1,
      hash: name,
      chunks: [
        {
          text: content,
          headingPath: '# Alpha',
          charStart: 0,
          charEnd: content.length,
          embedding: new Float32Array([1, 0, 0, 0]),
        },
      ],
    });
  }
  await populateMissingLinks();
  await populateMissingMarkdownReferences();
  upsertLinks('café/alpha.md'.normalize('NFD'), ['target.md']);
  upsertMarkdownLinks('café/alpha.md'.normalize('NFD'), ['target.md']);
  upsertNoteUrls('café/alpha.md'.normalize('NFD'), ['https://example.com/a']);
  const options: SearchOptions = {
    mode: 'fulltext',
    scope: ['café'],
    tag: ['café', '-blocked'],
    frontmatter: ['state:open'],
    limit: 7,
    snippetLength: 80,
    anchors: true,
  };
  const expected = await search('alpha', options);
  expect(expected).toHaveLength(1);
  expect(expected[0]?.previewAnchors).toBeDefined();
  let line = '';
  await handleStdioLine(
    JSON.stringify({ id: 'parity', query: 'alpha', options }),
    search,
    (output) => {
      line = output;
    },
  );
  expect(JSON.parse(line)).toEqual({ id: 'parity', results: expected });

  const env = {
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
  };
  const args = [
    '--import',
    pathToFileURL(path.join(root, 'dist/test/fixtures/vault-config-preload.js')).href,
    path.join(root, 'dist/src/cli.js'),
  ];
  const cli = spawnSync(
    process.execPath,
    [
      ...args,
      'search',
      'alpha',
      '--mode',
      'fulltext',
      '--scope',
      'café',
      '--tag',
      'café',
      '--tag=-blocked',
      '--frontmatter',
      'state:open',
      '--limit',
      '7',
      '--snippet-length',
      '80',
      '--anchors',
      '--json',
    ],
    { cwd: root, env, encoding: 'utf8', timeout: 15_000 },
  );
  expect(cli.status, cli.stderr).toBe(0);
  expect(JSON.parse(cli.stdout)).toEqual(expected);

  const client = new Client({ name: 'transport-parity', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...args, 'mcp'],
    cwd: root,
    env,
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const response = await client.callTool({
      name: 'search',
      arguments: {
        query: 'alpha',
        mode: 'fulltext',
        scope: ['café'],
        tag: ['café', '-blocked'],
        frontmatter: ['state:open'],
        limit: 7,
        snippet_length: 80,
        anchors: true,
      },
    });
    expect(response.isError).not.toBe(true);
    const content = response.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]!.text) as { results: SearchResult[] };
    expect(parsed.results).toEqual(expected);
  } finally {
    await client.close();
  }
}, 30_000);
