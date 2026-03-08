import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chunkNote, splitBySections, slidingWindow, estimateTokens } from '../src/chunker.js';

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
    assert.equal(sections[0].heading, '## Introduction');
    assert.equal(sections[1].heading, '## Conclusion');
  });

  it('filters empty sections', () => {
    const content = `## Section A\n\nSome content here that is long enough to pass.\n\n## Empty Section\n\n## Section B\n\nMore content here that is also long enough to pass the minimum filter.`;
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
    assert.equal(chunks[0].text, text);
  });

  it('splits long text into overlapping chunks', () => {
    const text = 'word '.repeat(1000);
    const chunks = slidingWindow(text, 50, 10);
    assert.ok(chunks.length > 1);
  });
});

describe('chunkNote', () => {
  it('short note returns single chunk', () => {
    const content = 'A short note about Zettelkasten method for personal knowledge management.';
    const chunks = chunkNote(content, 512);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].text, content.trim());
  });

  it('note without headings uses sliding window for long content', () => {
    const content = 'word '.repeat(3000);
    const chunks = chunkNote(content, 100);
    assert.ok(chunks.length > 1);
  });

  it('empty sections are filtered', () => {
    const content = `## Introduction\n\nThis section has substantial content that passes the minimum filter length.\n\n## Empty Section\n\n## Conclusion\n\nThis conclusion also has substantial content that passes the minimum filter length.`;
    const chunks = chunkNote(content, 512);
    assert.equal(chunks.length, 2);
  });

  it('oversized section falls back to sliding window', () => {
    const bigSection = `## Big Section\n\n${'word '.repeat(1000)}`;
    const chunks = chunkNote(bigSection, 50);
    assert.ok(chunks.length > 1);
  });
});
