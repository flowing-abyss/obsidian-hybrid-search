/**
 * Tests for the stdio IPC server protocol (handleStdioLine).
 *
 * Protocol-level tests use a mock search function (no DB interaction).
 * Integration tests use a real search function against a temp vault.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, it } from 'vitest';
import type { SearchFunction, StdioResponse } from '../src/stdio-server.js';
import { handleStdioLine } from '../src/stdio-server.js';

// ─── Vault setup ─────────────────────────────────────────────────────────────

const vaultDir = mkdtempSync(path.join(tmpdir(), 'ohs-serve-stdio-test-'));
process.env.OBSIDIAN_VAULT_PATH = vaultDir;

const { openDb, initVecTable, upsertNote } = await import('../src/db.js');
const { search, bumpIndexVersion } = await import('../src/searcher.js');

const fakeEmbedding = new Float32Array([0.5, 0.5, 0.5, 0.5]);

beforeAll(() => {
  openDb();
  initVecTable(4);
  bumpIndexVersion(); // invalidate any cached results from previous test suites
  upsertNote({
    path: 'alpha.md',
    title: 'Alpha Note',
    tags: ['pkm'],
    content: 'Alpha note about zettelkasten and linked thinking.',
    mtime: Date.now(),
    hash: 'h1',
    chunks: [{ text: 'Alpha note about zettelkasten', embedding: fakeEmbedding }],
  });
  upsertNote({
    path: 'beta.md',
    title: 'Beta Note',
    tags: [],
    content: 'Beta note about project management and tasks.',
    mtime: Date.now(),
    hash: 'h2',
    chunks: [{ text: 'Beta note about project management', embedding: fakeEmbedding }],
  });
});

afterAll(() => {
  rmSync(vaultDir, { recursive: true, force: true });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Run handleStdioLine and capture the single output line (or null if no output). */
async function processLine(
  line: string,
  searchFn: SearchFunction = search,
): Promise<string | null> {
  let output: string | null = null;
  await handleStdioLine(line, searchFn, (s) => {
    output = s;
  });
  return output;
}

function parseResponse(raw: string | null): StdioResponse {
  assert.ok(raw !== null, 'expected output line but got none');
  return JSON.parse(raw) as StdioResponse;
}

// ─── Protocol-level tests ─────────────────────────────────────────────────────

describe('handleStdioLine — protocol', () => {
  it('empty line produces no output', async () => {
    const output = await processLine('');
    assert.strictEqual(output, null);
  });

  it('whitespace-only line produces no output', async () => {
    const output = await processLine('   \t  ');
    assert.strictEqual(output, null);
  });

  it('invalid JSON returns error with id=unknown', async () => {
    const resp = parseResponse(await processLine('not valid json {'));
    assert.strictEqual(resp.id, 'unknown');
    assert.ok(typeof resp.error === 'string' && resp.error.length > 0, 'error must be non-empty');
    assert.strictEqual(resp.results, undefined);
  });

  it('missing query field returns error with correct id', async () => {
    const resp = parseResponse(await processLine('{"id":"req-42"}'));
    assert.strictEqual(resp.id, 'req-42');
    assert.ok(typeof resp.error === 'string', 'error must be a string');
    assert.ok(resp.error.includes('query'), 'error must mention query');
  });

  it('non-string query returns readable validation error with correct id', async () => {
    const resp = parseResponse(await processLine('{"id":"bad-query","query":123}'));
    assert.strictEqual(resp.id, 'bad-query');
    assert.strictEqual(resp.results, undefined);
    assert.ok(typeof resp.error === 'string', 'error must be a string');
    assert.ok(resp.error.includes('Invalid stdio request'), 'error must mention invalid request');
    assert.ok(resp.error.includes('query'), 'error must mention query');
  });

  it('invalid option type returns readable validation error with correct id', async () => {
    const resp = parseResponse(
      await processLine('{"id":"bad-limit","query":"alpha","options":{"limit":"1"}}'),
    );
    assert.strictEqual(resp.id, 'bad-limit');
    assert.strictEqual(resp.results, undefined);
    assert.ok(typeof resp.error === 'string', 'error must be a string');
    assert.ok(resp.error.includes('Invalid stdio request'), 'error must mention invalid request');
    assert.ok(resp.error.includes('limit'), 'error must mention limit');
  });

  it('invalid option domain returns readable validation error with correct id', async () => {
    const resp = parseResponse(
      await processLine('{"id":"bad-threshold","query":"alpha","options":{"threshold":2}}'),
    );
    assert.strictEqual(resp.id, 'bad-threshold');
    assert.strictEqual(resp.results, undefined);
    assert.ok(typeof resp.error === 'string', 'error must be a string');
    assert.ok(resp.error.includes('Invalid stdio request'), 'error must mention invalid request');
    assert.ok(resp.error.includes('threshold'), 'error must mention threshold');
  });

  it('request without id uses id=unknown in response', async () => {
    const resp = parseResponse(
      await processLine('{"query":"alpha","options":{"mode":"fulltext","limit":1}}'),
    );
    assert.strictEqual(resp.id, 'unknown');
    assert.ok(Array.isArray(resp.results));
  });

  it('valid request echoes the request id in response', async () => {
    const resp = parseResponse(
      await processLine('{"id":"req-99","query":"alpha","options":{"mode":"fulltext","limit":5}}'),
    );
    assert.strictEqual(resp.id, 'req-99');
    assert.ok(Array.isArray(resp.results));
    assert.strictEqual(resp.error, undefined);
  });

  it('search error returns error response without throwing', async () => {
    // eslint-disable-next-line @typescript-eslint/require-await
    const failSearch: SearchFunction = async () => {
      throw new Error('embedding service unavailable');
    };
    const resp = parseResponse(await processLine('{"id":"err-1","query":"test"}', failSearch));
    assert.strictEqual(resp.id, 'err-1');
    assert.ok(typeof resp.error === 'string');
    assert.ok(resp.error.includes('embedding service unavailable'));
    assert.strictEqual(resp.results, undefined);
  });

  it('search options are passed through to the search function', async () => {
    let capturedQuery = '';
    let capturedOpts: Parameters<SearchFunction>[1] = {};
    // eslint-disable-next-line @typescript-eslint/require-await
    const captureFn: SearchFunction = async (query, opts) => {
      capturedQuery = query;
      capturedOpts = opts ?? {};
      return [];
    };

    await handleStdioLine(
      '{"id":"1","query":"zettelkasten","options":{"mode":"fulltext","limit":3}}',
      captureFn,
      () => {},
    );

    assert.strictEqual(capturedQuery, 'zettelkasten');
    assert.deepEqual(capturedOpts, { mode: 'fulltext', limit: 3 });
  });

  it('response is a single JSON line with no embedded newlines', async () => {
    const raw = await processLine(
      '{"id":"line-check","query":"alpha","options":{"mode":"fulltext","limit":1}}',
    );
    assert.ok(raw !== null);
    assert.ok(!raw.includes('\n'), 'response must not contain newlines');
    JSON.parse(raw); // must parse without error
  });

  it('multiple sequential requests are processed independently', async () => {
    const outputs: string[] = [];
    const lines = [
      '{"id":"a","query":"alpha","options":{"mode":"fulltext","limit":1}}',
      '{"id":"b","query":"beta","options":{"mode":"fulltext","limit":1}}',
    ];
    for (const line of lines) {
      await handleStdioLine(line, search, (s) => outputs.push(s));
    }
    assert.strictEqual(outputs.length, 2);
    const respA = JSON.parse(outputs[0]!) as StdioResponse;
    const respB = JSON.parse(outputs[1]!) as StdioResponse;
    assert.strictEqual(respA.id, 'a');
    assert.strictEqual(respB.id, 'b');
  });
});

// ─── Integration: real search ─────────────────────────────────────────────────

describe('handleStdioLine — integration with real search', () => {
  it('finds indexed note by fulltext query', async () => {
    const resp = parseResponse(
      await processLine(
        '{"id":"i1","query":"zettelkasten","options":{"mode":"fulltext","limit":5}}',
      ),
    );
    assert.strictEqual(resp.id, 'i1');
    assert.ok(Array.isArray(resp.results), 'results must be an array');
    const paths = resp.results.map((r) => r.path);
    assert.ok(paths.includes('alpha.md'), `expected alpha.md in results, got: ${paths.join(', ')}`);
  });

  it('limit option caps result count', async () => {
    const resp = parseResponse(
      await processLine('{"id":"lim","query":"note","options":{"mode":"fulltext","limit":1}}'),
    );
    assert.ok(Array.isArray(resp.results));
    assert.ok(resp.results.length <= 1, `expected ≤1 results, got ${resp.results.length}`);
  });

  it('result items have required shape fields', async () => {
    const resp = parseResponse(
      await processLine('{"id":"shape","query":"alpha","options":{"mode":"fulltext","limit":5}}'),
    );
    assert.ok(Array.isArray(resp.results) && resp.results.length > 0, 'should return results');
    for (const r of resp.results) {
      assert.ok(typeof r.path === 'string', 'path must be string');
      assert.ok(typeof r.title === 'string', 'title must be string');
      assert.ok(typeof r.score === 'number', 'score must be number');
      assert.ok(Array.isArray(r.tags), 'tags must be array');
      assert.ok(Array.isArray(r.aliases), 'aliases must be array');
    }
  });

  it('frontmatter option is forwarded to search function', async () => {
    let capturedOpts: Parameters<SearchFunction>[1] = {};
    // eslint-disable-next-line @typescript-eslint/require-await
    const captureFn: SearchFunction = async (_query, opts) => {
      capturedOpts = opts ?? {};
      return [];
    };

    await handleStdioLine(
      '{"id":"fm1","query":"test","options":{"frontmatter":"status:active"}}',
      captureFn,
      () => {},
    );

    assert.deepEqual(capturedOpts, { frontmatter: 'status:active' });
  });

  it('frontmatter array option is forwarded to search function', async () => {
    let capturedOpts: Parameters<SearchFunction>[1] = {};
    // eslint-disable-next-line @typescript-eslint/require-await
    const captureFn: SearchFunction = async (_query, opts) => {
      capturedOpts = opts ?? {};
      return [];
    };

    await handleStdioLine(
      '{"id":"fm2","query":"test","options":{"frontmatter":["status:active","priority:high"]}}',
      captureFn,
      () => {},
    );

    assert.deepEqual(capturedOpts, { frontmatter: ['status:active', 'priority:high'] });
  });

  it('filter-only mode (empty query with tag) returns results', async () => {
    const resp = parseResponse(
      await processLine('{"id":"fo1","query":"","options":{"tag":"pkm"}}'),
    );
    assert.strictEqual(resp.id, 'fo1');
    assert.ok(Array.isArray(resp.results), 'results must be an array');
    const paths = resp.results.map((r) => r.path);
    assert.ok(paths.includes('alpha.md'), 'alpha.md has pkm tag and should appear');
  });
});
