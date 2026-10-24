export interface ContentIgnorePattern {
  readonly source: string;
  readonly flags: string;
}

type SourcePart = readonly [start: number, end: number] | ' ' | '\n';

interface ProjectionSegment {
  textStart: number;
  textEnd: number;
  sourceStart: number;
  sourceEnd: number;
  separator?: ' ' | '\n';
}

export interface ContentProjection {
  text: string;
  segments: readonly ProjectionSegment[] | null;
}

export interface MappedContentRange {
  charStart: number;
  charEnd: number;
  sourceSpans: readonly SourcePart[] | null;
}

const compiledPolicies = new WeakMap<readonly ContentIgnorePattern[], readonly RegExp[]>();
const settingName = 'OBSIDIAN_CONTENT_IGNORE_PATTERNS';

function patternError(rule: number, position: number, detail: string): Error {
  return new Error(`${settingName} rule ${rule} at position ${position + 1}: ${detail}`);
}

function skipWhitespace(raw: string, start: number): number {
  while (start < raw.length && /\s/u.test(raw[start]!)) start++;
  return start;
}

function findClosingSlash(raw: string, start: number, unicodeSets: boolean): number {
  let depth = 0;
  for (let index = start + 1; index < raw.length; index++) {
    const char = raw[index];
    if (char === '\\') index++;
    else if (char === '[' && (depth === 0 || unicodeSets)) depth++;
    else if (char === ']' && depth > 0) depth--;
    else if (char === '/' && depth === 0) return index;
  }
  return -1;
}

function readFlags(raw: string, start: number): { flags: string; end: number } {
  let end = start;
  while (end < raw.length && /[a-z]/i.test(raw[end]!)) end++;
  return { flags: raw.slice(start, end), end };
}

function readPattern(raw: string, start: number, rule: number) {
  if (raw[start] !== '/') throw patternError(rule, start, 'expected a /pattern/ literal');
  let closing = findClosingSlash(raw, start, false);
  if (closing === -1) throw patternError(rule, start, 'missing closing slash or character class');
  let tail = readFlags(raw, closing + 1);
  if (tail.flags.includes('v')) {
    closing = findClosingSlash(raw, start, true);
    if (closing === -1) throw patternError(rule, start, 'missing closing Unicode-set class');
    tail = readFlags(raw, closing + 1);
  }
  const source = raw.slice(start + 1, closing);
  try {
    const regexp = new RegExp(source, tail.flags);
    return { pattern: Object.freeze({ source, flags: regexp.flags }), end: tail.end };
  } catch {
    // Native SyntaxError messages quote the expression, which may contain private literals.
    throw patternError(rule, start, 'invalid regular expression or flags');
  }
}

export function parseContentIgnorePatterns(raw = ''): readonly ContentIgnorePattern[] {
  const patterns: ContentIgnorePattern[] = [];
  let index = skipWhitespace(raw, 0);
  while (index < raw.length) {
    const parsed = readPattern(raw, index, patterns.length + 1);
    patterns.push(parsed.pattern);
    index = skipWhitespace(raw, parsed.end);
    if (index === raw.length) break;
    if (raw[index] !== ',') {
      throw patternError(patterns.length, index, 'expected a comma between patterns');
    }
    index = skipWhitespace(raw, index + 1);
    if (index === raw.length) {
      throw patternError(patterns.length + 1, index, 'expected a pattern after the comma');
    }
  }
  return Object.freeze(patterns);
}

function compiledPatterns(patterns: readonly ContentIgnorePattern[]): readonly RegExp[] {
  let compiled = compiledPolicies.get(patterns);
  if (!compiled) {
    compiled = patterns.map(({ source, flags }) => new RegExp(source, flags));
    compiledPolicies.set(patterns, compiled);
  }
  return compiled;
}

type Interval = [start: number, end: number];

function bisectsSurrogatePair(source: string, index: number): boolean {
  const previous = source.charCodeAt(index - 1);
  const current = source.charCodeAt(index);
  return previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff;
}

function appendInterval(intervals: Interval[], start: number, end: number): void {
  const last = intervals.at(-1);
  if (last && start <= last[1]) last[1] = Math.max(last[1], end);
  else intervals.push([start, end]);
}

function matchIntervals(source: string, regexp: RegExp): Interval[] {
  const intervals: Interval[] = [];
  regexp.lastIndex = 0;
  for (let match = regexp.exec(source); match; match = regexp.exec(source)) {
    if (match[0].length) {
      let start = match.index;
      let end = start + match[0].length;
      if (bisectsSurrogatePair(source, start)) start--;
      if (bisectsSurrogatePair(source, end)) end++;
      appendInterval(intervals, start, end);
    } else if (regexp.global) {
      const fullUnicode = regexp.unicode || regexp.flags.includes('v');
      const width = fullUnicode && (source.codePointAt(regexp.lastIndex) ?? 0) > 0xffff ? 2 : 1;
      regexp.lastIndex += width;
    }
    if (!regexp.global) break;
  }
  return intervals;
}

function removalSeparator(source: string, start: number, end: number): ' ' | '\n' {
  for (let index = start; index < end; index++) {
    if (source[index] === '\r' || source[index] === '\n') return '\n';
  }
  return ' ';
}

export function projectContent(
  source: string,
  patterns: readonly ContentIgnorePattern[],
): ContentProjection {
  if (!patterns.length) return { text: source, segments: null };
  const matches = compiledPatterns(patterns)
    .flatMap((regexp) => matchIntervals(source, regexp))
    .sort((left, right) => left[0] - right[0]);
  if (!matches.length) return { text: source, segments: null };
  const intervals: Interval[] = [];
  for (const [start, end] of matches) appendInterval(intervals, start, end);

  const segments: ProjectionSegment[] = [];
  const text: string[] = [];
  let textLength = 0;
  let sourceStart = 0;
  const retain = (start: number, end: number) => {
    if (start === end) return;
    const textEnd = textLength + end - start;
    segments.push({ textStart: textLength, textEnd, sourceStart: start, sourceEnd: end });
    text.push(source.slice(start, end));
    textLength = textEnd;
  };
  for (const [start, end] of intervals) {
    retain(sourceStart, start);
    if (start > 0 && end < source.length) {
      const separator = removalSeparator(source, start, end);
      segments.push({
        textStart: textLength,
        textEnd: textLength + 1,
        sourceStart: start,
        sourceEnd: end,
        separator,
      });
      text.push(separator);
      textLength++;
    }
    sourceStart = end;
  }
  retain(sourceStart, source.length);
  return { text: text.join(''), segments };
}

function firstIntersectingSegment(segments: readonly ProjectionSegment[], start: number): number {
  let low = 0;
  let high = segments.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (segments[middle]!.textEnd <= start) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function mapContentRange(
  projection: ContentProjection,
  start: number,
  end: number,
): MappedContentRange {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start ||
    end > projection.text.length
  ) {
    throw new Error('Invalid nonempty content projection range');
  }
  if (projection.segments === null) return { charStart: start, charEnd: end, sourceSpans: null };
  const parts: SourcePart[] = [];
  let charStart = 0;
  let charEnd = 0;
  for (
    let index = firstIntersectingSegment(projection.segments, start);
    index < projection.segments.length;
    index++
  ) {
    const segment = projection.segments[index]!;
    if (segment.textStart >= end) break;
    const sourceStart = segment.separator
      ? segment.sourceStart
      : segment.sourceStart + Math.max(0, start - segment.textStart);
    const sourceEnd = segment.separator
      ? segment.sourceEnd
      : segment.sourceEnd - Math.max(0, segment.textEnd - end);
    if (!parts.length) charStart = sourceStart;
    charEnd = sourceEnd;
    parts.push(segment.separator ?? [sourceStart, sourceEnd]);
  }
  return {
    charStart,
    charEnd,
    sourceSpans: parts.length === 1 && Array.isArray(parts[0]) ? null : parts,
  };
}
