import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  mapContentRange,
  parseContentIgnorePatterns,
  projectContent,
  type MappedContentRange,
} from '../src/content/content-ignore.js';

function reconstruct(source: string, range: MappedContentRange): string {
  return range.sourceSpans === null
    ? source.slice(range.charStart, range.charEnd)
    : range.sourceSpans
        .map((part) => (typeof part === 'string' ? part : source.slice(part[0], part[1])))
        .join('');
}

describe('content pattern literals', () => {
  it.each([undefined, '', ' \n\t '])('keeps %j disabled', (input) => {
    expect(parseContentIgnorePatterns(input)).toEqual([]);
  });

  it('keeps commas, quantifiers, classes and escaped delimiters inside rules', () => {
    expect(parseContentIgnorePatterns(String.raw` /a,b{1,3}/g, /https:\/\/x\/y/gi `)).toEqual([
      { source: 'a,b{1,3}', flags: 'g' },
      { source: String.raw`https:\/\/x\/y`, flags: 'gi' },
    ]);
    expect(parseContentIgnorePatterns('/[a/b,]+/g')).toEqual([{ source: '[a/b,]+', flags: 'g' }]);
    expect(parseContentIgnorePatterns(String.raw`/\\/g,/\//g`)).toEqual([
      { source: String.raw`\\`, flags: 'g' },
      { source: String.raw`\/`, flags: 'g' },
    ]);
  });

  it('distinguishes legacy literal brackets from nested Unicode sets', () => {
    expect(parseContentIgnorePatterns('/[[]/g')[0]?.source).toBe('[[]');
    expect(parseContentIgnorePatterns(String.raw`/[a&&[b\/c]]/v`)).toEqual([
      { source: String.raw`[a&&[b\/c]]`, flags: 'v' },
    ]);
    expect(parseContentIgnorePatterns(String.raw`/[\q{a\/b|c}]/gv`)).toEqual([
      { source: String.raw`[\q{a\/b|c}]`, flags: 'gv' },
    ]);
  });

  it.each(['/[[]/v,/abc]/g', '/[[]/v/]/g'])(
    'does not swallow rule boundaries after an inconsistent Unicode-set scan %s',
    (raw) => {
      expect(() => parseContentIgnorePatterns(raw)).toThrow(
        /OBSIDIAN_CONTENT_IGNORE_PATTERNS.*rule 1/,
      );
    },
  );

  it('parses a nested Unicode-set rule followed by ordinary rules', () => {
    expect(parseContentIgnorePatterns(String.raw`/[a&&[b\/c]]/v,/second/g,/third/`)).toEqual([
      { source: String.raw`[a&&[b\/c]]`, flags: 'v' },
      { source: 'second', flags: 'g' },
      { source: 'third', flags: '' },
    ]);
  });

  it.each([
    '/a/gg',
    '/a/uv',
    '/a/z',
    '/unterminated',
    '/[/g',
    '/(/g',
    '/a/g,',
    ',/a/g',
    '/a/g,,/b/g',
    '/a/g trailing',
    'a/g',
  ])('rejects malformed rule list %s', (input) => {
    expect(() => parseContentIgnorePatterns(input)).toThrow(/OBSIDIAN_CONTENT_IGNORE_PATTERNS/);
  });

  it('identifies the invalid rule without printing a private expression', () => {
    try {
      parseContentIgnorePatterns('/valid/g, /PRIVATE_SENTINEL(/g');
      expect.fail('Expected invalid content pattern');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/rule 2.*position \d+/i);
      expect((error as Error).message).not.toContain('PRIVATE_SENTINEL');
    }
  });
});

describe('content projection', () => {
  it('preserves identity and all source offsets when disabled or unmatched', () => {
    const source = '# Visible\r\n%%Keep knowledge%% 😀';
    for (const patterns of [[], parseContentIgnorePatterns('/absent/g')]) {
      const projection = projectContent(source, patterns);
      expect(projection).toEqual({ text: source, segments: null });
      expect(mapContentRange(projection, 2, 9)).toEqual({
        charStart: 2,
        charEnd: 9,
        sourceSpans: null,
      });
    }
  });

  it('removes content without joining unrelated words and maps the original body', () => {
    const source = 'A%%hidden%%B';
    const projection = projectContent(source, parseContentIgnorePatterns('/%%.*?%%/g'));
    expect(projection.text).toBe('A B');
    expect(mapContentRange(projection, 0, 3)).toEqual({
      charStart: 0,
      charEnd: 12,
      sourceSpans: [[0, 1], ' ', [11, 12]],
    });
    expect(mapContentRange(projection, 2, 3)).toEqual({
      charStart: 11,
      charEnd: 12,
      sourceSpans: null,
    });
    expect(mapContentRange(projection, 1, 2)).toEqual({
      charStart: 1,
      charEnd: 11,
      sourceSpans: [' '],
    });
  });

  it.each([
    ['%%gone%%visible', 'visible'],
    ['visible%%gone%%', 'visible'],
    ['%%gone%%', ''],
    ['left%%gone\r\nblock%%right', 'left\nright'],
    ['left\r\n%%gone%%\r\nright', 'left\r\n \r\nright'],
  ])('removes matched intervals from %j', (source, expected) => {
    const projection = projectContent(
      source,
      parseContentIgnorePatterns(String.raw`/%%[\s\S]*?%%/g`),
    );
    expect(projection.text).toBe(expected);
    if (expected.length) {
      expect(reconstruct(source, mapContentRange(projection, 0, expected.length))).toBe(expected);
    }
  });

  it('unions overlapping/adjacent matches against the same original body', () => {
    expect(projectContent('abc', parseContentIgnorePatterns('/b/g,/ac/g')).text).toBe('a c');
    const source = 'leftABCDEright';
    expect(projectContent(source, parseContentIgnorePatterns('/ABCD/g,/CDE/g')).text).toBe(
      'left right',
    );
    expect(projectContent(source, parseContentIgnorePatterns('/CDE/g,/ABCD/g')).text).toBe(
      'left right',
    );
    expect(projectContent(source, parseContentIgnorePatterns('/AB/g,/CDE/g')).text).toBe(
      'left right',
    );
  });

  it.each([
    ['a a', '/a/', ' a'],
    ['a a', '/a/g', ' '],
    ['a A', '/a/gi', ' '],
    ['aa b a', '/a/gy', ' b a'],
    ['b a', '/a/y', 'b a'],
    ['a\nb', '/^b/m', 'a\n'],
    ['a\nb', '/a.b/s', ''],
    ['leftabc right', '/abc/dg', 'left  right'],
    ['leftb right', '/[[a-z]&&[^a]]/gv', ' '],
  ])('honors native literal matching for %s using %s', (source, pattern, expected) => {
    expect(projectContent(source, parseContentIgnorePatterns(pattern)).text).toBe(expected);
  });

  it.each(['/^/g', '/(?=.)/g', '/(?=.)/gu', '/(?=.)/gv', '//g', '/$/gu'])(
    'terminates without removing content for zero-width %s',
    (pattern) => {
      expect(projectContent('😀 alpha\n', parseContentIgnorePatterns(pattern))).toEqual({
        text: '😀 alpha\n',
        segments: null,
      });
    },
  );

  it('resets stateful expressions for every source and preserves surrogate pairs', () => {
    const patterns = parseContentIgnorePatterns('/remove/g');
    expect(projectContent('remove keep', patterns).text).toBe(' keep');
    expect(projectContent('remove keep', patterns).text).toBe(' keep');
    expect(projectContent('😀', parseContentIgnorePatterns(String.raw`/\uD83D/g`)).text).toBe('');
    expect(projectContent('😀', parseContentIgnorePatterns(String.raw`/\uDE00/g`)).text).toBe('');
    const projection = projectContent('😀%%x%%😀', parseContentIgnorePatterns('/%%x%%/g'));
    expect(projection.text).toBe('😀 😀');
    expect(mapContentRange(projection, 3, 5)).toEqual({
      charStart: 7,
      charEnd: 9,
      sourceSpans: null,
    });
  });

  it('keeps discontiguous ranges exact for repeated text and partial ranges', () => {
    const source = 'same%%one%%same%%two%%same';
    const projection = projectContent(source, parseContentIgnorePatterns('/%%.*?%%/g'));
    expect(projection.text).toBe('same same same');
    for (let start = 0; start < projection.text.length; start++) {
      for (let end = start + 1; end <= projection.text.length; end++) {
        const range = mapContentRange(projection, start, end);
        expect(reconstruct(source, range)).toBe(projection.text.slice(start, end));
        expect(range.charStart).toBeGreaterThanOrEqual(0);
        expect(range.charEnd).toBeLessThanOrEqual(source.length);
      }
    }
  });

  it('reconstructs generated Unicode slices without a per-character offset map', () => {
    const retained = fc
      .array(fc.constantFrom('a', 'б', '😀', '\r\n', ' '), { maxLength: 20 })
      .map((parts) => parts.join(''));
    fc.assert(
      fc.property(fc.array(retained, { minLength: 2, maxLength: 12 }), (parts) => {
        const source = parts.join('%%hidden%%');
        const projection = projectContent(source, parseContentIgnorePatterns('/%%hidden%%/g'));
        if (!projection.text.length) return;
        const range = mapContentRange(projection, 0, projection.text.length);
        expect(reconstruct(source, range)).toBe(projection.text);
        expect(projection.segments!.length).toBeLessThanOrEqual(parts.length * 2 - 1);
        expect(projection.text).not.toMatch(/[\uD800-\uDFFF]/u);
      }),
    );
  });

  it('rejects invalid projected coordinate ranges instead of publishing wrong anchors', () => {
    const projection = projectContent('abc', []);
    for (const [start, end] of [
      [-1, 1],
      [1, 4],
      [2, 1],
      [0.5, 1],
      [0, Number.NaN],
    ]) {
      expect(() => mapContentRange(projection, start!, end!)).toThrow(/range/i);
    }
  });
});
