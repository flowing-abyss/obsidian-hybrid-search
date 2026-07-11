import assert from 'node:assert/strict';
import { describe, it, vi } from 'vitest';
import { createDocumentTextProjector, embedChunksWithRecovery } from '../src/chunk-embedding.js';
import { createChunkBoundaryIndex, type Chunk } from '../src/chunker.js';
import type { EmbeddingOutcome } from '../src/embedder.js';

const vector = (value: number): Float32Array => new Float32Array([value, 0, 0, 0]);

function chunk(source: string, start: number, end: number, headings: string[] = []): Chunk {
  return {
    text: source.slice(start, end),
    headingChain: headings,
    charStart: start,
    charEnd: end,
  };
}

describe('embedChunksWithRecovery', () => {
  it('embeds an initially successful batch once without changing its leaves', async () => {
    const source = 'alpha\nbeta';
    const chunks = [chunk(source, 0, 5), chunk(source, 6, 10)];
    const embed = vi.fn(async (texts: string[]): Promise<EmbeddingOutcome[]> =>
      texts.map((_, index) => ({ ok: true, embedding: vector(index + 1) })),
    );

    const result = await embedChunksWithRecovery({
      source,
      chunks,
      boundaryIndex: createChunkBoundaryIndex(source),
      project: (body) => body,
      embed,
    });

    assert.equal(embed.mock.calls.length, 1);
    assert.deepEqual(
      result.map(({ chunk: leaf }) => leaf),
      chunks,
    );
    assert.deepEqual(
      result.map(({ embedding }) => embedding?.[0]),
      [1, 2],
    );
  });

  it('splits only a rejected leaf and recursively embeds ordered source-aligned children', async () => {
    const source = 'sibling\nabcdefgh';
    const headings = ['# Parent', '## Child'];
    const chunks = [chunk(source, 0, 7), chunk(source, 8, source.length, headings)];
    const seen: string[][] = [];
    const embed = vi.fn(async (texts: string[]): Promise<EmbeddingOutcome[]> => {
      seen.push(texts);
      return texts.map((text) =>
        text !== 'sibling' && text.length > 2
          ? { ok: false, kind: 'input_too_long', message: 'too long' }
          : { ok: true, embedding: vector(text.length) },
      );
    });

    const result = await embedChunksWithRecovery({
      source,
      chunks,
      boundaryIndex: createChunkBoundaryIndex(source),
      project: (body) => body,
      embed,
    });

    assert.deepEqual(seen[0], ['sibling', 'abcdefgh']);
    assert.equal(seen.slice(1).flat().includes('sibling'), false, 'successful sibling re-embedded');
    assert.equal(result[0]!.chunk.text, 'sibling');
    const children = result.slice(1);
    assert.deepEqual(
      children.map(({ chunk: leaf }) => leaf.text),
      ['ab', 'cd', 'ef', 'gh'],
    );
    for (const { chunk: leaf, embedding } of children) {
      assert.deepEqual(leaf.headingChain, headings);
      assert.equal(leaf.text, source.slice(leaf.charStart, leaf.charEnd));
      assert.ok(embedding);
    }
    for (let index = 1; index < children.length; index++) {
      assert.equal(children[index - 1]!.chunk.charEnd, children[index]!.chunk.charStart);
    }
    assert.equal(result.length, result.map(({ embedding }) => embedding).length);
    assert.ok(embed.mock.calls.length <= 8, 'requests must be bounded by produced tree nodes');
  });

  it('keeps non-size failures and unsplittable size failures as one null leaf', async () => {
    const source = 'a\nb';
    const chunks = [chunk(source, 0, 1), chunk(source, 2, 3)];
    const embed = vi.fn(async (): Promise<EmbeddingOutcome[]> => [
      { ok: false, kind: 'permanent', status: 400, message: 'generic bad request' },
      { ok: false, kind: 'input_too_long', message: 'too long' },
    ]);

    const result = await embedChunksWithRecovery({
      source,
      chunks,
      boundaryIndex: createChunkBoundaryIndex(source),
      project: (body) => body,
      embed,
    });

    assert.equal(embed.mock.calls.length, 1);
    assert.deepEqual(
      result.map(({ chunk: leaf, embedding }) => [leaf.text, embedding]),
      [
        ['a', null],
        ['b', null],
      ],
    );
  });

  it('keeps retry child ranges source-aligned without gaps at whitespace boundaries', async () => {
    const source = 'hello world';
    const embed = vi.fn(async (texts: string[]): Promise<EmbeddingOutcome[]> =>
      texts.map((text) =>
        text.length > 6
          ? { ok: false, kind: 'input_too_long', message: 'too long' }
          : { ok: true, embedding: vector(text.length) },
      ),
    );

    const result = await embedChunksWithRecovery({
      source,
      chunks: [chunk(source, 0, source.length)],
      boundaryIndex: createChunkBoundaryIndex(source),
      project: (body) => body,
      embed,
    });

    assert.equal(result.length, 2);
    assert.equal(result[0]!.chunk.charStart, 0);
    assert.equal(result[0]!.chunk.charEnd, result[1]!.chunk.charStart);
    assert.equal(result[1]!.chunk.charEnd, source.length);
    for (const { chunk: leaf } of result) {
      assert.equal(leaf.text, source.slice(leaf.charStart, leaf.charEnd));
    }
  });

  it('terminates repeated size rejection at depth 8 with bounded requests and cardinality', async () => {
    const source = 'x'.repeat(512);
    const embed = vi.fn(async (texts: string[]): Promise<EmbeddingOutcome[]> =>
      texts.map(() => ({ ok: false, kind: 'input_too_long', message: 'still too long' })),
    );

    const result = await embedChunksWithRecovery({
      source,
      chunks: [chunk(source, 0, source.length)],
      boundaryIndex: createChunkBoundaryIndex(source),
      project: (body) => body,
      embed,
      maxDepth: 8,
    });

    assert.equal(result.length, 256);
    assert.ok(result.every(({ embedding }) => embedding === null));
    assert.equal(embed.mock.calls.length, 511);
    assert.equal(result.length, result.map(({ embedding }) => embedding).length);
  });
});

describe('createDocumentTextProjector', () => {
  it('shrinks supplemental context against the exact combined body input', () => {
    const title = `😀${'T'.repeat(24)}`;
    const body = 'b'.repeat(90);
    const policy = {
      limit: 100,
      count: (text: string) => Array.from(text).length,
    };
    const projector = createDocumentTextProjector(title, policy);

    const projected = projector(body, []);
    const prefix = projected.slice(0, projected.indexOf('\n'));

    assert.ok(policy.count(projected) <= policy.limit);
    assert.equal(projected.slice(projected.indexOf('\n') + 1), body);
    assert.equal(prefix, `😀${'T'.repeat(8)}`);
    assert.equal(prefix.includes('\ud83d') && !prefix.includes('\ude00'), false);
  });

  it('keeps the canonical separator when the context budget is zero', () => {
    const projector = createDocumentTextProjector('', {
      limit: 3,
      count: (text) => Array.from(text).length,
    });

    assert.equal(projector('body', []), '\nbody');
  });

  it('caps context, retains the title, and selects headings deepest-first in path order', () => {
    const projector = createDocumentTextProjector('Title', {
      limit: 48,
      count: (text) => Array.from(text).length,
    });

    assert.equal(projector('body', ['# ParentLong', '## Deep']), 'Title > Deep\nbody');
  });

  it('truncates only the embedding prefix at a Unicode-safe boundary', () => {
    const title = 'A😀BCDEFG';
    const body = 'raw body remains unchanged';
    const projector = createDocumentTextProjector(title, {
      limit: 20,
      count: (text) => Array.from(text).length,
    });

    const projected = projector(body, []);
    const [prefix, projectedBody] = projected.split('\n');
    assert.equal(projectedBody, body);
    assert.equal(prefix, 'A😀BCD');
    assert.equal(prefix.includes('\ud83d') && !prefix.includes('\ude00'), false);
    assert.equal(title, 'A😀BCDEFG');
  });
});
