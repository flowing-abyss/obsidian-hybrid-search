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
const { indexFile, prepareIndexFile } = await import('../src/indexing/indexer.js');
const stage = await import('../src/storage/index-rebuild.js');
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

it('records embedding provenance without preparing accepted inputs again', async () => {
  const embedder = await import('../src/inference/embedder.js');
  const originalPolicy = embedder.getDocumentTokenPolicy;
  let calls = 0;
  let callsAfterRequest = 0;
  const marker = 'uniquepreparationmarker';
  const spy = vi.spyOn(embedder, 'getDocumentTokenPolicy').mockImplementation(async () => {
    const policy = await originalPolicy();
    return {
      ...policy,
      count: (text: string) => {
        calls++;
        if (inputs.some((input) => input.includes(marker))) callsAfterRequest++;
        return policy.count(text);
      },
    };
  });
  const filename = path.join(vault, 'preparation.md');
  writeFileSync(filename, `Visible planetary ${marker}.`);
  try {
    await storage.withTestIndexRun(async (owner) => {
      const ordinary = await prepareIndexFile(
        owner,
        filename,
        8192,
        { isIgnored: () => false },
        true,
      );
      assert.equal(ordinary.kind, 'prepared');
      assert.equal(
        callsAfterRequest,
        0,
        'Accepted input was tokenized again after its HTTP request',
      );
      const ordinaryCalls = calls;
      inputs.length = 0;
      calls = 0;
      callsAfterRequest = 0;
      const candidate = await prepareIndexFile(
        { ...owner, reuseEmbeddings: true },
        filename,
        8192,
        { isIgnored: () => false },
        true,
      );
      assert.equal(candidate.kind, 'prepared');
      assert.equal(
        inputs.filter((input) => input.includes(marker)).length,
        1,
        'A missing reusable vector must still be embedded',
      );
      assert.equal(callsAfterRequest, 0);
      assert.equal(
        calls,
        ordinaryCalls,
        'A reuse miss must use its already prepared candidate inputs',
      );
      if (ordinary.kind === 'prepared' && candidate.kind === 'prepared')
        assert.equal(candidate.note.embeddingContext, ordinary.note.embeddingContext);
    });
  } finally {
    spy.mockRestore();
  }
});

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

it('rejects a prepared note with a different policy before replacing staged content', async () => {
  const filename = path.join(vault, 'proof.md');
  writeFileSync(filename, 'Visible %%hiddenneedle%% body.');
  const filter = createContentFilter(parseContentIgnorePatterns(rule));
  try {
    await storage.withTestIndexRun(async (owner) => {
      const identity = await prepareIndexFile(
        owner,
        filename,
        8192,
        { isIgnored: () => false },
        true,
      );
      const filtered = await prepareIndexFile(
        { ...owner, contentFilter: filter },
        filename,
        8192,
        { isIgnored: () => false },
        true,
      );
      assert.equal(identity.kind, 'prepared');
      assert.equal(filtered.kind, 'prepared');
      if (identity.kind !== 'prepared' || filtered.kind !== 'prepared')
        throw new Error('Missing prepared fixture');
      const id = stage.beginRebuild(owner.lease, {
        modelName: filtered.modelName,
        embeddingDim: 4,
        contentPolicySignature: filter.signature,
        metadata: {
          vaultPath: vault,
          apiBaseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiModel: 'text-embedding-3-small',
        },
      });
      stage.stageRebuildNote(
        owner.lease,
        id,
        filtered.note,
        filtered.frontmatterRaw,
        filtered.fingerprint,
        filtered.contentPolicySignature,
      );
      const staged = JSON.stringify(stage.readRebuildNotes(id));
      const chunksBefore = storage
        .getDb()
        .prepare('SELECT * FROM index_rebuild_chunks ORDER BY ordinal')
        .all();
      for (const proof of [
        identity.contentPolicySignature,
        'different-policy',
        undefined as unknown as string,
      ]) {
        assert.throws(
          () =>
            stage.stageRebuildNote(
              owner.lease,
              id,
              identity.note,
              identity.frontmatterRaw,
              identity.fingerprint,
              proof,
            ),
          /content policy/i,
        );
        assert.equal(JSON.stringify(stage.readRebuildNotes(id)), staged);
        assert.deepEqual(
          storage.getDb().prepare('SELECT * FROM index_rebuild_chunks ORDER BY ordinal').all(),
          chunksBefore,
        );
      }
      assert.equal(identity.contentPolicySignature, 'none');
      assert.equal(filtered.contentPolicySignature, filter.signature);
      assert.equal(storage.getActiveContentPolicySignature(), 'none');
      stage.setRebuildReferences(owner.lease, id, filtered.note.path, {
        links: [],
        markdownLinks: [],
        urls: [],
      });
      stage.publishRebuild(owner.lease, id);
      assert.equal(storage.getActiveContentPolicySignature(), filter.signature);
      assert.ok(!storage.getNoteByPath('proof.md')!.content.includes('hiddenneedle'));
      assert.equal(
        storage
          .getDb()
          .prepare("SELECT count(*) FROM notes_fts_bm25 WHERE notes_fts_bm25 MATCH 'hiddenneedle'")
          .pluck()
          .get(),
        0,
      );
    });
  } finally {
    await filter.close();
  }
});
