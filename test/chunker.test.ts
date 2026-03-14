import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { chunkNote, estimateTokens, slidingWindow, splitBySections } from '../src/chunker.js';

describe('estimateTokens', () => {
  it('approximates tokens as chars/4', () => {
    assert.equal(estimateTokens('hello'), 2);
    assert.equal(estimateTokens('a'.repeat(100)), 25);
  });
});

describe('splitBySections', () => {
  it('splits by headings', () => {
    const content = `## Introduction\n\nThis is the intro section with enough text to pass the minimum length filter.\n\n## Conclusion\n\nThis is the conclusion section with enough text to pass the minimum length filter.`;
    const sections = splitBySections(content);
    assert.equal(sections.length, 2);
    assert.equal(sections[0]!.heading, '## Introduction');
    assert.equal(sections[1]!.heading, '## Conclusion');
  });

  it('filters empty sections', () => {
    const content = `## Section A\n\nSome content here that is long enough to pass the minimum filter.\n\n## Empty Section\n\n## Section B\n\nMore content here that is also long enough to pass the minimum filter.`;
    const sections = splitBySections(content);
    assert.equal(sections.length, 2);
    assert.ok(sections.some((s) => s.heading === '## Section A'));
    assert.ok(sections.some((s) => s.heading === '## Section B'));
  });
});

describe('slidingWindow', () => {
  it('returns single chunk for short text', () => {
    const text = 'Short text that fits within context.';
    const chunks = slidingWindow(text, 512, 64);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]!.text, text);
  });

  it('splits long text into overlapping chunks', () => {
    const text = 'word '.repeat(1000);
    const chunks = slidingWindow(text, 50, 10);
    assert.ok(chunks.length > 1);
  });
});

describe('splitBySections heading chain', () => {
  it('single-level heading gets chain with itself', () => {
    const content = `## Methods\n\nContent about methods that is long enough to pass filter.\n\n## Results\n\nContent about results that is long enough to pass filter.`;
    const sections = splitBySections(content);
    assert.deepEqual(sections[0]!.headingChain, ['## Methods']);
    assert.deepEqual(sections[1]!.headingChain, ['## Results']);
  });

  it('nested headings build full ancestor chain', () => {
    const body = 'Body content that is long enough to pass the minimum length filter.';
    const content = `# Guide\n\n${body}\n\n## Installation\n\n${body}\n\n### Requirements\n\n${body}`;
    const sections = splitBySections(content);
    assert.deepEqual(sections[0]!.headingChain, ['# Guide']);
    assert.deepEqual(sections[1]!.headingChain, ['# Guide', '## Installation']);
    assert.deepEqual(sections[2]!.headingChain, ['# Guide', '## Installation', '### Requirements']);
  });

  it('same-level heading resets deeper ancestors', () => {
    const body = 'Body content that is long enough to pass the minimum length filter.';
    const content = `# Top\n\n${body}\n\n## Alpha\n\n${body}\n\n### Alpha sub\n\n${body}\n\n## Beta\n\n${body}`;
    const sections = splitBySections(content);
    const beta = sections.find((s) => s.heading === '## Beta')!;
    assert.deepEqual(beta.headingChain, ['# Top', '## Beta']);
  });

  it('skipped heading level does not crash and includes available ancestors', () => {
    const body = 'Body content that is long enough to pass the minimum length filter.';
    const content = `# Top\n\n${body}\n\n### Skipped level\n\n${body}`;
    const sections = splitBySections(content);
    assert.equal(sections.length, 2);
    assert.deepEqual(sections[1]!.headingChain, ['# Top', '### Skipped level']);
  });

  it('heading with no space after # treated as body text, not heading', () => {
    const content = `## Real Heading\n\nBody text and ##NotAHeading is just inline text that is long enough.`;
    const sections = splitBySections(content);
    assert.equal(sections.length, 1);
    assert.deepEqual(sections[0]!.headingChain, ['## Real Heading']);
  });

  it('# lines inside fenced code blocks are not treated as headings', () => {
    const body = 'Body content that is long enough to pass the minimum length filter.';
    const content = `## Real Section\n\n${body}\n\n\`\`\`shell\n# this is a comment\nobsidian daily:append content="test"\n\`\`\`\n\nMore body content after code block.\n\n## Next Section\n\n${body}`;
    const sections = splitBySections(content);
    // Should have exactly 2 sections (Real Section and Next Section), not 3
    assert.equal(sections.length, 2);
    assert.equal(sections[0]!.heading, '## Real Section');
    assert.equal(sections[1]!.heading, '## Next Section');
    assert.deepEqual(sections[0]!.headingChain, ['## Real Section']);
    assert.deepEqual(sections[1]!.headingChain, ['## Next Section']);
  });

  it('handles unclosed code fence without crashing', () => {
    const body = 'Body content that is long enough to pass the minimum length filter.';
    const content = `## Section\n\n${body}\n\n\`\`\`\n# orphan comment with no closing fence\nsome code\n`;
    const sections = splitBySections(content);
    assert.equal(sections.length, 1);
    assert.equal(sections[0]!.heading, '## Section');
  });

  it('content before any heading has empty chain', () => {
    const body = 'Body content that is long enough to pass the minimum length filter.';
    const content = `${body}\n\n## Later Heading\n\n${body}`;
    const sections = splitBySections(content);
    assert.deepEqual(sections[0]!.headingChain, []);
    assert.deepEqual(sections[1]!.headingChain, ['## Later Heading']);
  });
});

describe('chunkNote heading chain', () => {
  it('chunks from sections carry headingChain', () => {
    const body = 'Body content that is long enough to pass the minimum length filter.';
    const content = `# Guide\n\n${body}\n\n## Details\n\n${body}`;
    // Use small contextLength to force section-based splitting
    const chunks = chunkNote(content, 30);
    assert.equal(chunks.length, 2);
    assert.deepEqual(chunks[0]!.headingChain, ['# Guide']);
    assert.deepEqual(chunks[1]!.headingChain, ['# Guide', '## Details']);
  });

  it('sliding-window chunks on notes without headings have empty chain', () => {
    const content = 'word '.repeat(3000);
    const chunks = chunkNote(content, 100);
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      assert.deepEqual(chunk.headingChain, []);
    }
  });

  it('short note with no heading has empty chain', () => {
    const content = 'A short note about Zettelkasten.';
    const chunks = chunkNote(content, 512);
    assert.deepEqual(chunks[0]!.headingChain, []);
  });
});

describe('chunkNote', () => {
  it('short note returns single chunk', () => {
    const content = 'A short note about Zettelkasten method for personal knowledge management.';
    const chunks = chunkNote(content, 512);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]!.text, content.trim());
  });

  it('note without headings uses sliding window for long content', () => {
    const content = 'word '.repeat(3000);
    const chunks = chunkNote(content, 100);
    assert.ok(chunks.length > 1);
  });

  it('empty sections are filtered', () => {
    const content = `## Introduction\n\nThis section has substantial content that passes the minimum filter length.\n\n## Empty Section\n\n## Conclusion\n\nThis conclusion also has substantial content that passes the minimum filter length.`;
    const chunks = chunkNote(content, 30);
    assert.equal(chunks.length, 2);
  });

  it('oversized section falls back to sliding window', () => {
    const bigSection = `## Big Section\n\n${'word '.repeat(1000)}`;
    const chunks = chunkNote(bigSection, 50);
    assert.ok(chunks.length > 1);
  });
});
