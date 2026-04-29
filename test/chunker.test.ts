import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  buildMatchText,
  chunkNote,
  estimateTokens,
  slidingWindow,
  splitBySections,
} from '../src/chunker.js';

describe('estimateTokens', () => {
  it('approximates tokens as chars/4', () => {
    assert.equal(estimateTokens('hello'), 2);
    assert.equal(estimateTokens('a'.repeat(100)), 25);
  });

  it('counts Cyrillic chars as ~1 token each', () => {
    assert.equal(estimateTokens('Привет'), 6);
  });

  it('counts CJK chars as ~1 token each', () => {
    assert.equal(estimateTokens('你好世界'), 4);
  });

  it('mixed ASCII and non-ASCII', () => {
    // 'hi' = 2 * 0.25 = 0.5 → ceil = 1
    // 'Привет' = 6 * 1 = 6
    assert.equal(estimateTokens('hiПривет'), 7);
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

  it('falls back to single chunk when all text would be skipped', () => {
    const text = '---\n'; // horizontal separator matches skip pattern
    const chunks = slidingWindow(text, 512, 64, [], 0);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]!.text, text.trim());
    assert.equal(chunks[0]!.charStart, 0);
    assert.equal(chunks[0]!.charEnd, text.length);
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

  it('oversized section in multi-section note uses sliding window', () => {
    const longBody = 'word '.repeat(1000);
    const shortBody =
      'This is a moderately long section body that passes the minimum length filter easily.';
    const content = `## Small Section\n\n${shortBody}\n\n## Big Section\n\n${longBody}`;
    const chunks = chunkNote(content, 50);
    assert.ok(chunks.length > 2);
  });
});

describe('splitBySections — position tracking', () => {
  it('flat note: charStart=0', () => {
    const content = 'This is body text long enough to exceed the minimum chunk length threshold.';
    const sections = splitBySections(content);
    assert.equal(sections.length, 1);
    assert.equal(sections[0]!.charStart, 0);
  });

  it('note with heading: body charStart = heading.length + 1', () => {
    const heading = '## Section';
    const body = 'Body text long enough to exceed the minimum chunk length filter here.';
    const content = `${heading}\n${body}`;
    const sections = splitBySections(content);
    assert.equal(sections.length, 1);
    // charStart points to start of heading line (not body)
    assert.equal(sections[0]!.charStart, 0);
    assert.ok(content.slice(sections[0]!.charStart).startsWith(heading));
  });

  it('multiple sections: slice matches section text', () => {
    const body = 'Body content that is long enough to pass the minimum length filter here.';
    const content = `## First\n${body}\n## Second\n${body}`;
    const sections = splitBySections(content);
    assert.equal(sections.length, 2);
    // content.slice(charStart) starts with the section's heading
    assert.ok(content.slice(sections[0]!.charStart).startsWith('## First'));
    assert.ok(content.slice(sections[1]!.charStart).startsWith('## Second'));
  });
});

describe('slidingWindow — position tracking', () => {
  it('single chunk: charStart = sectionOffset', () => {
    const text = 'Short text that fits within context window.';
    const chunks = slidingWindow(text, 512, 64, [], 50);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]!.charStart, 50);
    assert.equal(chunks[0]!.charEnd, 50 + text.length);
  });

  it('multiple windows: charStart increases by step', () => {
    const text = 'word '.repeat(300);
    const chunks = slidingWindow(text, 50, 10, [], 0);
    assert.ok(chunks.length > 1);
    assert.equal(chunks[0]!.charStart, 0);
    assert.ok(chunks[1]!.charStart > 0);
    assert.ok(chunks[1]!.charStart < chunks[1]!.charEnd);
  });
});

describe('buildMatchText', () => {
  it('strips bold and italic', () => {
    assert.equal(buildMatchText('**bold** and *italic*'), 'bold and italic');
  });

  it('strips wikilinks with alias, using alias text', () => {
    assert.equal(buildMatchText('[[My Note|alias]]'), 'alias');
  });

  it('strips wikilinks without alias, using target text', () => {
    assert.equal(buildMatchText('[[My Note]]'), 'My Note');
  });

  it('strips task checkbox', () => {
    assert.equal(buildMatchText('- [ ] task item text here'), 'task item text here');
  });

  it('strips list marker', () => {
    assert.equal(buildMatchText('- plain list item text here'), 'plain list item text here');
  });

  it('skips heading line, returns body', () => {
    assert.equal(
      buildMatchText('## Creating Notes\nAtomic notes are the core principle.'),
      'Atomic notes are the core principle.',
    );
  });

  it('strips markdown link', () => {
    assert.equal(buildMatchText('[link text](https://example.com)'), 'link text');
  });

  it('truncates to 80 chars', () => {
    const result = buildMatchText('a'.repeat(200));
    assert.equal(result.length, 80);
  });

  it('falls back to first line when all are headings', () => {
    const result = buildMatchText('## Only a heading');
    assert.ok(result.length > 0);
    assert.ok(!result.startsWith('##'));
  });

  it('strips callout type marker from first line', () => {
    assert.equal(
      buildMatchText('> [!faq] Правильный вопрос\n> body text here'),
      'Правильный вопрос',
    );
  });

  it('strips plain blockquote marker', () => {
    assert.equal(buildMatchText('> Some quoted text here'), 'Some quoted text here');
  });

  it('skips callout type-only line (empty title) and uses next line', () => {
    assert.equal(
      buildMatchText('> [!quote]\n> Любая сложная мысль требует фиксации.'),
      'Любая сложная мысль требует фиксации.',
    );
  });

  it('strips embed wikilinks ![[Note]] entirely', () => {
    assert.equal(buildMatchText('![[Some embedded note]] and more text'), 'and more text');
  });

  it('strips fenced code block delimiter lines', () => {
    assert.equal(
      buildMatchText('```table-of-contents\nstyle: nestedList\n```\nActual content here'),
      'Actual content here',
    );
  });

  it('returns empty string when all lines strip to nothing', () => {
    assert.equal(buildMatchText('![image](url)'), '');
  });
});
