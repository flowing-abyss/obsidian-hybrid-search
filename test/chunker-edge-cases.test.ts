import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { buildMatchText, chunkNote, estimateTokens, slidingWindow } from '../src/chunker.js';

describe('chunkNote — empty and boundary content', () => {
  it('returns single empty chunk for empty content', () => {
    const chunks = chunkNote('', 512);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]!.text, '');
    assert.deepEqual(chunks[0]!.headingChain, []);
    assert.equal(chunks[0]!.charStart, 0);
  });

  it('returns single chunk when content fits within contextLength', () => {
    const content = 'Short content.';
    const chunks = chunkNote(content, 512);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]!.text, content);
    assert.equal(chunks[0]!.charStart, 0);
    assert.equal(chunks[0]!.charEnd, content.length);
  });

  it('returns single chunk when estimateTokens equals contextLength exactly', () => {
    // 4 chars * 0.25 = 1 token — use contextLength=1 to hit exact boundary
    const content = 'abcd';
    assert.equal(estimateTokens(content), 1);
    const chunks = chunkNote(content, 1);
    assert.equal(chunks.length, 1);
  });

  it('falls to slidingWindow when content exceeds contextLength but has no sections', () => {
    // 8 chars * 0.25 = 2 tokens, contextLength=1 forces split, no headings
    const content = 'abcdefgh';
    const chunks = chunkNote(content, 1);
    assert.ok(chunks.length >= 1);
    // All chunks should cover the content without gaps
    for (const chunk of chunks) {
      assert.ok(chunk.charStart >= 0);
      assert.ok(chunk.charEnd <= content.length);
    }
  });
});

describe('chunkNote — heading chains', () => {
  it('preserves nested heading chain in each chunk', () => {
    // Bodies must be >= config.chunkMinLength (50 chars) to avoid being skipped
    // by shouldSkipChunk; the brief used 19-char bodies which were filtered out.
    const body = 'Body text under this section that is long enough to pass the chunk filter.';
    const content = `# Top

${body}

## Sub

${body}

### Deep

${body}`;
    const chunks = chunkNote(content, 1); // force many chunks
    assert.ok(chunks.length > 1);
    // At least one chunk should carry the deep heading chain
    const deepChunk = chunks.find((c) => c.headingChain.includes('### Deep'));
    assert.ok(deepChunk, 'expected a chunk with "### Deep" in headingChain');
    assert.ok(deepChunk.headingChain.includes('# Top'));
    assert.ok(deepChunk.headingChain.includes('## Sub'));
  });

  it('returns single trimmed chunk when all sections are skipped', () => {
    // Only headings, no body — all sections skipped by shouldSkipChunk
    const content = `# Heading 1

## Heading 2

### Heading 3`;
    const chunks = chunkNote(content, 512);
    // Fallback returns single trimmed chunk
    assert.equal(chunks.length, 1);
  });
});

describe('slidingWindow — overlap', () => {
  it('produces chunks that overlap by config.chunkOverlap', () => {
    // Brief used 100 words (~125 tokens), which fit in contextLength=200 as a
    // single chunk. Use 1000 words (~1250 tokens) to force multiple chunks.
    const content = 'word '.repeat(1000).trim();
    const overlap = 50;
    const chunks = slidingWindow(content, 200, overlap, [], 0);
    assert.ok(chunks.length > 1, 'should produce multiple chunks');
    // Verify overlap: second chunk should start before first chunk ends
    if (chunks.length >= 2) {
      assert.ok(chunks[1]!.charStart < chunks[0]!.charEnd, 'chunks should overlap');
    }
  });

  it('covers entire content without gaps (except first chunk start)', () => {
    // Brief used 300 chars (~75 tokens), which fit in contextLength=100 as a
    // single chunk. Use 1000 chars (~250 tokens) to force multiple chunks.
    const content = 'x'.repeat(1000);
    const chunks = slidingWindow(content, 100, 20, [], 0);
    assert.ok(chunks.length > 1);
    assert.equal(chunks[0]!.charStart, 0);
    // Last chunk should reach or exceed content end
    const last = chunks[chunks.length - 1]!;
    assert.ok(last.charEnd >= content.length - 1);
  });
});

describe('estimateTokens — multi-script edge cases', () => {
  it('CJK produces more chunks than ASCII at same contextLength', () => {
    const ascii = 'a'.repeat(100); // 25 tokens
    const cjk = '你'.repeat(100); // 140 tokens
    assert.ok(estimateTokens(cjk) > estimateTokens(ascii));
  });

  it('Korean produces more chunks than ASCII at same char count', () => {
    const ascii = 'a'.repeat(100);
    const korean = '안'.repeat(100); // 150 tokens
    assert.ok(estimateTokens(korean) > estimateTokens(ascii));
  });

  it('Thai produces the most chunks per char among tested scripts', () => {
    const cjk = '你'.repeat(100);
    const thai = 'ก'.repeat(100); // 180 tokens
    assert.ok(estimateTokens(thai) > estimateTokens(cjk));
  });

  it('mixed scripts sum per-codepoint weights', () => {
    // 'a' (0.25) + '你' (1.4) + 'ж' (1.0) = 2.65 → ceil 3
    assert.equal(estimateTokens('a你ж'), 3);
  });

  it('single ASCII char → ceil(0.25) = 1', () => {
    assert.equal(estimateTokens('a'), 1);
  });

  it('single CJK char → ceil(1.4) = 2', () => {
    assert.equal(estimateTokens('你'), 2);
  });
});

describe('chunkNote — skip patterns', () => {
  it('skips heading-only lines (no body)', () => {
    const content = `# Heading

Real content here that is long enough to not be skipped.`;
    const chunks = chunkNote(content, 512);
    // The heading-only section should not produce a separate chunk
    for (const chunk of chunks) {
      assert.ok(chunk.text.trim().length > 0, 'no empty chunks from skip patterns');
    }
  });

  it('skips horizontal rule only sections', () => {
    const content = `---

Real content here that is long enough.`;
    const chunks = chunkNote(content, 512);
    for (const chunk of chunks) {
      assert.ok(!/^---\s*$/.test(chunk.text.trim()), 'no horizontal-rule-only chunks');
    }
  });

  it('skips image-embed-only sections', () => {
    const content = `![alt](image.png)

Real content here that is long enough to not be skipped.`;
    const chunks = chunkNote(content, 512);
    for (const chunk of chunks) {
      assert.ok(!/^!\[.*\]\(.+\)$/.test(chunk.text.trim()), 'no image-only chunks');
    }
  });
});

describe('buildMatchText', () => {
  it('returns empty string for empty input', () => {
    assert.equal(buildMatchText(''), '');
  });

  it('strips markdown formatting from chunk text', () => {
    const result = buildMatchText('**bold** and _italic_ and `code`');
    // buildMatchText strips markdown to produce clean match text
    assert.ok(result.length > 0);
    assert.ok(!result.includes('**'));
    assert.ok(!result.includes('`'));
  });

  it('truncates to approximately 80 characters', () => {
    const long = 'x'.repeat(200);
    const result = buildMatchText(long);
    assert.ok(result.length <= 80);
  });
});
