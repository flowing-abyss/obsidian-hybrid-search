import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, it, vi } from 'vitest';
import { parseContentIgnorePatterns } from '../src/content/content-ignore.js';
import { createContentFilter } from '../src/indexing/content-filter.js';

const vault = mkdtempSync(path.join(tmpdir(), 'ohs-content-pipeline-'));
const inputs: string[] = [];
let inputLimit = Infinity;
const server = createServer((request, response) => {
  const buffers: Buffer[] = [];
  request.on('data', (data: Buffer) => buffers.push(data));
  request.on('end', () => {
    if (request.method !== 'POST') {
      response.writeHead(404).end();
      return;
    }
    const { input } = JSON.parse(Buffer.concat(buffers).toString()) as { input: string[] };
    inputs.push(...input);
    response.setHeader('content-type', 'application/json');
    if (input.some((text) => text.length > inputLimit)) {
      response.writeHead(400).end(JSON.stringify({ error: { message: 'input is too long' } }));
      return;
    }
    response.end(
      JSON.stringify({
        data: input.map((text, index) => ({
          index,
          embedding: text.includes('planetary') ? [1, 0, 0, 0] : [0.8, 0.6, 0, 0],
        })),
      }),
    );
  });
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
if (!address || typeof address === 'string') throw new Error('HTTP fixture did not bind TCP');
vi.stubEnv('OBSIDIAN_VAULT_PATH', vault);
vi.stubEnv('OBSIDIAN_IGNORE_PATTERNS', '');
vi.stubEnv('OBSIDIAN_INCLUDE_PATTERNS', '');
vi.stubEnv('OBSIDIAN_RESPECT_GITIGNORE', 'false');
vi.stubEnv('OPENAI_BASE_URL', `http://127.0.0.1:${address.port}/v1`);
vi.stubEnv('OPENAI_API_KEY', 'fixture');
vi.stubEnv('OPENAI_EMBEDDING_MODEL', 'text-embedding-3-small');

const storage = await import('./helpers/owned-storage.js');
const { indexFile } = await import('../src/indexing/indexer.js');
const { getEmbeddingDim, clearOllamaSemaphore } = await import('../src/inference/embedder.js');
const { reranker } = await import('../src/inference/reranker.js');
const capturedCandidates: string[] = [];
vi.spyOn(reranker, 'scoreAll').mockImplementation((_query, candidates) => {
  capturedCandidates.push(...candidates.map((candidate) => JSON.stringify(candidate)));
  return Promise.resolve(candidates.map(() => 1));
});
const { search, readNotes } = await import('../src/search/searcher.js');
const rule = '/%%[\\s\\S]*?%%/g';
const body = [
  '# Visible heading',
  '',
  'A public paragraph about planetary rings. 😀',
  '%% hiddenneedle #hidden-tag [[Hidden target]] [Hidden](Hidden%20target.md) https://private.invalid/hiddenneedle %%',
  '%%\n## hidden-heading\nMore hiddenneedle\n%%',
  '## Research',
  '',
  'Visible planetary rings and [[Public target]]. #visible-tag',
].join('\n');
const raw = `---\ntitle: Public title\ntags: [yaml-tag]\naliases: [Ring study]\n---\n${body}`;

beforeEach(() => {
  storage.wipeDatabaseFiles();
  storage.openDb();
  storage.initVecTable(4);
  inputs.length = 0;
  capturedCandidates.length = 0;
  inputLimit = Infinity;
});
afterAll(async () => {
  storage.closeDb();
  clearOllamaSemaphore();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
  vi.unstubAllEnvs();
  rmSync(vault, { recursive: true, force: true });
});

async function index(files: Record<string, string>, patterns = rule, contextLength = 8192) {
  const contentFilter = createContentFilter(parseContentIgnorePatterns(patterns));
  try {
    await storage.withTestIndexRun(async (owner) => {
      const run = { ...owner, contentFilter };
      for (const [name, content] of Object.entries(files)) {
        const filename = path.join(vault, name);
        writeFileSync(filename, content);
        assert.equal(await indexFile(run, filename, contextLength), 'indexed');
      }
    });
  } finally {
    await contentFilter.close();
  }
}

function chunks(notePath: string) {
  return storage
    .getDb()
    .prepare(
      `SELECT text, heading_path, char_start, char_end, source_spans
    FROM chunks WHERE note_id=(SELECT id FROM notes WHERE path=?) ORDER BY chunk_index`,
    )
    .all(notePath) as Array<{
    text: string;
    heading_path: string | null;
    char_start: number;
    char_end: number;
    source_spans: string | null;
  }>;
}

function assertSourceMap(notePath: string, source: string) {
  const rows = chunks(notePath);
  for (const row of rows) {
    const parts = row.source_spans
      ? (JSON.parse(row.source_spans) as Array<[number, number] | string>)
      : [[row.char_start, row.char_end]];
    const restored = parts
      .map((part) => (typeof part === 'string' ? part : source.slice(part[0], part[1])))
      .join('');
    assert.equal(restored, row.text);
    assert.ok(row.char_start >= 0 && row.char_end <= source.length);
  }
  return rows;
}

it('keeps the filtered projection throughout SQLite, HTTP embedding, retrieval and reranking, while read stays original', async () => {
  assert.equal(await getEmbeddingDim({ refresh: true }), 4);
  await index({ 'Public target.md': 'Other planetary research.', 'projection.md': raw });
  const note = storage.getNoteByPath('projection.md')!;
  assert.ok(!note.content.includes('hiddenneedle'));
  assert.deepEqual(JSON.parse(note.tags), ['yaml-tag', 'visible-tag']);
  assert.equal(note.title, 'Public title');
  const original = readNotes(['projection.md'])[0];
  assert.ok(original?.found);
  assert.equal(original.content, body);
  assertSourceMap('projection.md', body);
  const db = storage.getDb();
  assert.equal(
    db.prepare("SELECT count(*) FROM links WHERE to_path LIKE '%Hidden%'").pluck().get(),
    0,
  );
  assert.equal(db.prepare('SELECT count(*) FROM markdown_links').pluck().get(), 0);
  assert.equal(db.prepare('SELECT count(*) FROM note_urls').pluck().get(), 0);
  assert.deepEqual(await search('hiddenneedle', { mode: 'fulltext' }), []);
  for (const options of [
    { mode: 'fulltext' as const },
    { mode: 'semantic' as const },
    { mode: 'hybrid' as const, rerank: true },
    { notePath: 'Public target.md', related: true, direction: 'backlinks' as const },
  ]) {
    const found = await search('planetary', {
      ...options,
      limit: 10,
      snippetLength: 1000,
      anchors: true,
    });
    assert.ok(
      found.some((result) => result.path === 'projection.md'),
      JSON.stringify(found),
    );
    assert.ok(!JSON.stringify(found).includes('hiddenneedle'));
  }
  assert.ok(capturedCandidates.length > 0);
  for (const text of [...inputs, ...capturedCandidates, JSON.stringify(chunks('projection.md'))]) {
    assert.ok(!/hiddenneedle|hidden-heading|hidden-tag/.test(text), text);
  }
});

it('preserves default comments and contiguous offsets when no patterns are configured', async () => {
  await index({ 'projection.md': raw }, '');
  assert.equal(storage.getNoteByPath('projection.md')?.content, body);
  assert.ok(inputs.some((text) => text.includes('hiddenneedle')));
  assert.equal((await search('hiddenneedle', { mode: 'fulltext' }))[0]?.path, 'projection.md');
  assert.ok(assertSourceMap('projection.md', body).every((row) => row.source_spans === null));
});

it('indexes title metadata for an entirely removed body without embedding the removed text', async () => {
  await index({ 'empty.md': '---\ntitle: Empty retained title\n---\n%% hiddenneedle %%' });
  assert.equal(storage.getNoteByPath('empty.md')?.content, '');
  assert.deepEqual(chunks('empty.md'), []);
  assert.equal(inputs.length, 0);
  assert.equal((await search('retained', { mode: 'fulltext' }))[0]?.path, 'empty.md');
  await search('', { notePath: 'empty.md' });
  assert.ok(inputs.every((text) => !text.includes('hiddenneedle')));
});

it('maps accepted provider recovery leaves against the original Unicode and CRLF source', async () => {
  inputLimit = 120;
  const paragraph = 'Visible planetary research 😀 '.repeat(18);
  const source = `${paragraph}\r\n%% hiddenneedle 😀 %%\r\n${paragraph}\r\n## Research\r\n${paragraph}`;
  await index({ 'recovery.md': source }, rule);
  const rows = assertSourceMap('recovery.md', source);
  assert.ok(rows.length > 5);
  assert.ok(rows.every((row) => !row.text.includes('hiddenneedle')));
  assert.ok(
    inputs.some((text) => text.length > inputLimit),
    'fixture must exercise provider rejection',
  );
  assert.ok(inputs.some((text) => text.length <= inputLimit));
  const removedStart = source.indexOf('%%');
  const removedEnd = source.indexOf('%%', removedStart + 2) + 2;
  for (let offset = 0; offset < source.length; offset++) {
    if (/\s/.test(source[offset]!) || (offset >= removedStart && offset < removedEnd)) continue;
    assert.ok(
      rows.some((row) => {
        const spans = row.source_spans
          ? (JSON.parse(row.source_spans) as Array<[number, number] | string>)
          : [[row.char_start, row.char_end]];
        return spans.some((span) => Array.isArray(span) && span[0] <= offset && span[1] > offset);
      }),
      `retained source offset ${offset} missing`,
    );
  }
});

it('persists separator-only recovery leaves without inventing retained source characters', async () => {
  inputLimit = 120;
  const source = 'A%%hidden%%B';
  await index({ 'separator.md': `---\ntitle: ${'T'.repeat(118)}\n---\n${source}` });
  const rows = assertSourceMap('separator.md', source);
  assert.ok(rows.some((row) => row.text === ' ' && row.source_spans === '[" "]'));
  assert.equal(rows.map((row) => row.text).join(''), 'A B');
});

it('removes a large generated drawing payload before chunking and keeps no-match text exact', async () => {
  const source = `Visible planetary caption.\n%%${'drawing-data,'.repeat(Math.ceil((16 * 1024 * 1024) / 13))}%%\nVisible end.`;
  await index({ 'drawing.md': source, 'no-match.md': 'Visible unchanged 😀\r\nSecond paragraph.' });
  assert.ok(storage.getNoteByPath('drawing.md')!.content.length < 100);
  assertSourceMap('drawing.md', source);
  assert.ok(inputs.every((text) => text.length < 200));
  assert.equal(
    storage.getNoteByPath('no-match.md')!.content,
    'Visible unchanged 😀\r\nSecond paragraph.',
  );
  assert.ok(chunks('no-match.md').every((row) => row.source_spans === null));
});
