import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  type Chunk,
  type ProjectedTokenCounter,
  createChunkBoundaryIndex,
  estimateTokens,
  getChunkBoundaryIndexStats,
  refineChunksToFit,
  splitChunkForRetry,
} from '../src/chunker.js';

const countChars: ProjectedTokenCounter = (text, headings) =>
  `Title > ${headings.join(' > ')}\n${text}`.length;

function sourceChunk(source: string, headingChain: string[] = []): Chunk {
  return {
    text: source,
    headingChain,
    charStart: 0,
    charEnd: source.length,
  };
}

function assertSourceAligned(source: string, chunks: readonly Chunk[]): void {
  for (const chunk of chunks) {
    assert.equal(chunk.text, source.slice(chunk.charStart, chunk.charEnd));
    assert.ok(chunk.charStart < chunk.charEnd || source.length === 0);
    assert.ok(chunk.charStart === 0 || !/[\uDC00-\uDFFF]/.test(source[chunk.charStart]!));
    assert.ok(chunk.charEnd === source.length || !/[\uDC00-\uDFFF]/.test(source[chunk.charEnd]!));
  }
}

describe('refineChunksToFit', () => {
  it('leaves an aligned fitting chunk unchanged', () => {
    const source = 'Compact source text that fits.';
    const initial = [sourceChunk(source, ['## Detail'])];

    const refined = refineChunksToFit(source, initial, 120, countChars, 12);

    assert.deepEqual(refined, initial);
  });

  it('splits projected text to fit while preserving source alignment', () => {
    const source = Array.from(
      { length: 8 },
      (_, index) => `Paragraph ${index}: ${'body '.repeat(12).trim()}.`,
    ).join('\n\n');
    const initial = [sourceChunk(source, ['# Long Note', '## Detail'])];

    const refined = refineChunksToFit(source, initial, 120, countChars, 12);

    assert.ok(refined.length > initial.length);
    assertSourceAligned(source, refined);
    for (const chunk of refined) {
      assert.ok(countChars(chunk.text, chunk.headingChain) <= 120);
      assert.deepEqual(chunk.headingChain, initial[0]!.headingChain);
    }
  });

  it('aligns legacy section and window offsets without changing text or headings', () => {
    const source = '  ## Heading\n\nBody text with useful detail.  \n\nTrailing text.';
    const sectionText = '## Heading\n\nBody text with useful detail.';
    const windowText = 'Trailing text.';
    const initial: Chunk[] = [
      {
        text: sectionText,
        headingChain: ['## Heading'],
        charStart: 0,
        charEnd: sectionText.length,
      },
      {
        text: windowText,
        headingChain: ['## Heading'],
        charStart: source.indexOf(windowText) - 2,
        charEnd: source.length,
      },
    ];

    const refined = refineChunksToFit(source, initial, 200, countChars, 0);

    assert.deepEqual(
      refined.map(({ text, headingChain }) => ({ text, headingChain })),
      initial.map(({ text, headingChain }) => ({ text, headingChain })),
    );
    assertSourceAligned(source, refined);
    assert.equal(refined[0]!.charStart, source.indexOf(sectionText));
    assert.equal(refined[1]!.charStart, source.indexOf(windowText));
  });

  it('splits when title and heading projection pushes a fitting body over the limit', () => {
    const source = 'body '.repeat(18).trim();
    const headings = ['# A projected heading that consumes the remaining budget'];
    assert.ok(source.length < 100);
    assert.ok(countChars(source, headings) > 100);

    const refined = refineChunksToFit(source, [sourceChunk(source, headings)], 100, countChars, 0);

    assert.ok(refined.length > 1);
    assertSourceAligned(source, refined);
    assert.ok(refined.every((chunk) => countChars(chunk.text, chunk.headingChain) <= 100));
  });

  it('prefers a reference-list boundary over nearby whitespace and hard splits', () => {
    const prefix = 'Context '.repeat(9).trim();
    const references = '[alpha]: https://example.com/alpha\n[beta]: https://example.com/beta';
    const source = `${prefix}\n\n${references}`;
    const counter: ProjectedTokenCounter = (text) => text.length;

    const refined = refineChunksToFit(source, [sourceChunk(source)], 90, counter, 0);

    assert.ok(refined.length > 1);
    assert.equal(refined[0]!.text, prefix);
    assert.equal(refined[1]!.charStart, source.indexOf('[alpha]'));
    assertSourceAligned(source, refined);
  });

  it('hard-splits percent-encoded URLs without gaps or broken surrogate pairs', () => {
    const source = `https://example.test/${'%F0%9F%93%9A'.repeat(14)}😀tail`;
    const counter: ProjectedTokenCounter = (text) => text.length;

    const refined = refineChunksToFit(source, [sourceChunk(source)], 29, counter, 0);

    assert.ok(refined.length > 2);
    assertSourceAligned(source, refined);
    assert.equal(refined[0]!.charStart, 0);
    assert.equal(refined.at(-1)!.charEnd, source.length);
    for (let index = 1; index < refined.length; index++) {
      assert.equal(refined[index]!.charStart, refined[index - 1]!.charEnd);
    }
    assert.ok(refined.every((chunk) => chunk.text.length <= 29));
  });

  it('handles CRLF, emoji, combining marks, and a short final tail', () => {
    const source = `First e\u0301 line with text.\r\nSecond 😀 line with text.\r\nok`;
    const counter: ProjectedTokenCounter = (text) => text.length;

    const refined = refineChunksToFit(source, [sourceChunk(source)], 24, counter, 3);

    assert.ok(refined.length > 1);
    assertSourceAligned(source, refined);
    assert.ok(refined.at(-1)!.text.endsWith('ok'));
    assert.ok(refined.every((chunk) => chunk.text.length <= 24));
    for (const chunk of refined) {
      assert.ok(!chunk.text.startsWith('\n') || source[chunk.charStart - 1] !== '\r');
      assert.ok(!chunk.text.endsWith('\r') || source[chunk.charEnd] !== '\n');
    }
  });

  it('bounds overlap so it can never prevent strict progress', () => {
    const source = 'abcdefghij'.repeat(20);
    const counter: ProjectedTokenCounter = (text) => text.length;

    const refined = refineChunksToFit(
      source,
      [sourceChunk(source)],
      10,
      counter,
      Number.MAX_SAFE_INTEGER,
    );

    assert.ok(refined.length > 1);
    assert.ok(refined.length <= source.length);
    for (let index = 1; index < refined.length; index++) {
      assert.ok(refined[index]!.charStart > refined[index - 1]!.charStart);
    }
  });

  it('returns an unsplittable one-code-point chunk once instead of looping', () => {
    const source = '😀';
    const counter: ProjectedTokenCounter = () => 2;

    const refined = refineChunksToFit(source, [sourceChunk(source)], 1, counter, 100);

    assert.deepEqual(refined, [sourceChunk(source)]);
  });

  it('exact-checks candidates when projected counts are non-monotonic', () => {
    const source = 'x'.repeat(83);
    const counter: ProjectedTokenCounter = (text, _headingChain) =>
      text.length === 24 ? 1000 : text.length;

    const refined = refineChunksToFit(source, [sourceChunk(source)], 30, counter, 0);

    assertSourceAligned(source, refined);
    assert.equal(refined[0]!.charStart, 0);
    assert.equal(refined.at(-1)!.charEnd, source.length);
    assert.ok(refined.every((chunk) => counter(chunk.text, chunk.headingChain) <= 30));
  });

  it('finds a bounded later fitting island when the first candidate is over budget', () => {
    const source = 'abcdefghijklmnopqrst';
    const counter: ProjectedTokenCounter = (text, _headingChain) => (text.length === 2 ? 2 : 100);

    const refined = refineChunksToFit(source, [sourceChunk(source)], 2, counter, 0);

    assertSourceAligned(source, refined);
    assert.equal(refined[0]!.charStart, 0);
    assert.equal(refined.at(-1)!.charEnd, source.length);
    assert.ok(refined.every((chunk) => counter(chunk.text, chunk.headingChain) <= 2));
  });

  it('returns a distant fitting island unresolved after bounded local lookahead', () => {
    const source = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let calls = 0;
    let countedCharacters = 0;
    const counter: ProjectedTokenCounter = (text, _headingChain) => {
      calls++;
      countedCharacters += text.length;
      return text.length === 18 ? 18 : 100;
    };

    const refined = refineChunksToFit(source, [sourceChunk(source)], 18, counter, 0);

    assertSourceAligned(source, refined);
    assert.deepEqual(refined, [sourceChunk(source)]);
    assert.ok(calls <= 18, `${calls} projected count calls`);
    assert.ok(
      countedCharacters <= source.length + 153,
      `${countedCharacters} counted characters for ${source.length} source characters`,
    );
  });

  it('measures overlap in estimated tokens for ASCII and CJK text', () => {
    const counter: ProjectedTokenCounter = (text) => text.length;
    const asciiSource = 'a'.repeat(300);
    const cjkSource = '界'.repeat(300);
    const ascii = refineChunksToFit(asciiSource, [sourceChunk(asciiSource)], 64, counter, 4);
    const cjk = refineChunksToFit(cjkSource, [sourceChunk(cjkSource)], 64, counter, 4);

    const asciiOverlap = asciiSource.slice(ascii[1]!.charStart, ascii[0]!.charEnd);
    const cjkOverlap = cjkSource.slice(cjk[1]!.charStart, cjk[0]!.charEnd);
    assert.ok(asciiOverlap.length > cjkOverlap.length);
    assert.ok(estimateTokens(asciiOverlap) <= 4);
    assert.ok(estimateTokens(cjkOverlap) <= 4);
    assert.ok(estimateTokens(asciiOverlap) > 0);
    assert.ok(estimateTokens(cjkOverlap) > 0);
  });

  it('uses fewer than 100 projected count calls per produced chunk', () => {
    const source = Array.from(
      { length: 1200 },
      (_, index) => `- synthetic reference ${index}: ${'payload '.repeat(8).trim()}`,
    ).join('\n');
    let calls = 0;
    let countedCharacters = 0;
    const counter: ProjectedTokenCounter = (text) => {
      calls++;
      countedCharacters += text.length;
      return text.length;
    };

    const refined = refineChunksToFit(source, [sourceChunk(source)], 240, counter, 24);

    assert.ok(refined.length > 100);
    assertSourceAligned(source, refined);
    assert.ok(calls < refined.length * 100, `${calls} calls for ${refined.length} chunks`);
    assert.ok(
      countedCharacters < source.length * 30,
      `${countedCharacters} counted characters for ${source.length} source characters`,
    );
  });

  it('caps huge overlap so candidate-counted text remains bounded', () => {
    const source = 'x'.repeat(5000);
    let countedCharacters = 0;
    const counter: ProjectedTokenCounter = (text) => {
      countedCharacters += text.length;
      return text.length;
    };

    const refined = refineChunksToFit(
      source,
      [sourceChunk(source)],
      128,
      counter,
      Number.MAX_SAFE_INTEGER,
    );

    assert.ok(refined.length < 200, `${refined.length} chunks for ${source.length} characters`);
    assert.ok(
      countedCharacters < source.length * 50,
      `${countedCharacters} counted characters for ${source.length} source characters`,
    );
    for (let index = 1; index < refined.length; index++) {
      assert.ok(refined[index]!.charStart > refined[index - 1]!.charStart);
    }
  });

  it('reuses one shared boundary index for refinement and retry splits', () => {
    const source = Array.from(
      { length: 300 },
      (_, index) => `Paragraph ${index}. ${'content '.repeat(6).trim()}`,
    ).join('\n\n');
    const boundaryIndex = createChunkBoundaryIndex(source);
    const counter: ProjectedTokenCounter = (text) => text.length;

    const refined = refineChunksToFit(
      source,
      [sourceChunk(source)],
      160,
      counter,
      16,
      boundaryIndex,
    );
    const afterRefinement = getChunkBoundaryIndexStats(boundaryIndex);
    assert.ok(refined.length > 10);
    assert.ok(afterRefinement.boundaryVisits > 0);

    let pending = [sourceChunk(source)];
    for (let round = 0; round < 5; round++) {
      pending = pending.flatMap((chunk) => {
        const split = splitChunkForRetry(source, chunk, boundaryIndex);
        return split ?? [chunk];
      });
    }

    const afterRetry = getChunkBoundaryIndexStats(boundaryIndex);
    assert.equal(afterRetry.collections, 1);
    assert.ok(afterRetry.boundaryVisits > afterRefinement.boundaryVisits);
  });
});

describe('splitChunkForRetry', () => {
  it('returns ordered, strictly smaller children at a natural midpoint boundary', () => {
    const source = `${'A'.repeat(25)}\n\n${'B'.repeat(25)}`;
    const chunk = sourceChunk(source, ['## Retry']);

    const split = splitChunkForRetry(source, chunk);

    assert.ok(split);
    const [left, right] = split;
    assert.equal(left.text, 'A'.repeat(25));
    assert.equal(right.text, 'B'.repeat(25));
    assert.ok(left.charStart < left.charEnd);
    assert.ok(left.charEnd <= right.charStart);
    assert.ok(left.text.length < chunk.text.length);
    assert.ok(right.text.length < chunk.text.length);
    assert.deepEqual(left.headingChain, chunk.headingChain);
    assert.deepEqual(right.headingChain, chunk.headingChain);
    assertSourceAligned(source, split);
  });

  it('returns null for a one-code-point range', () => {
    const source = '😀';

    assert.equal(splitChunkForRetry(source, sourceChunk(source)), null);
  });

  it('reuses one boundary collection with bounded work across recursive splits', () => {
    const source = Array.from(
      { length: 2048 },
      (_, index) => `Paragraph ${index}. ${'body '.repeat(8).trim()}`,
    ).join('\n\n');
    const boundaryIndex = createChunkBoundaryIndex(source);
    const pending = [sourceChunk(source)];
    const leaves: Chunk[] = [];
    let maxDepth = 0;

    while (pending.length > 0) {
      const chunk = pending.pop()!;
      const depth = Math.ceil(Math.log2(source.length / Math.max(1, chunk.text.length)));
      maxDepth = Math.max(maxDepth, depth);
      if (chunk.text.length <= 256) {
        leaves.push(chunk);
        continue;
      }
      const split = splitChunkForRetry(source, chunk, boundaryIndex);
      assert.ok(split);
      pending.push(split[1], split[0]);
    }

    const stats = getChunkBoundaryIndexStats(boundaryIndex);
    assert.ok(leaves.length > 100);
    assert.equal(stats.collections, 1);
    assert.ok(stats.boundaryVisits <= stats.boundaryCount * (maxDepth + 2));
  });
});
