import { config } from './config.js';

export interface Chunk {
  text: string;
  headingChain: string[];
  charStart: number;
  charEnd: number;
}

export type ProjectedTokenCounter = (text: string, headingChain: readonly string[]) => number;

interface Boundary {
  position: number;
  priority: number;
}

const BOUNDARY_PRIORITY = {
  CODE_POINT: 0,
  WHITESPACE: 1,
  SENTENCE: 2,
  LINE_END: 3,
  MARKDOWN_LINE: 4,
  REFERENCE: 5,
  BLANK_LINE: 6,
} as const;

const SKIP_PATTERNS = [
  /^#{1,6}\s*$/, // heading without content
  /^-{3,}$/, // horizontal separator
  /^(TODO|FIXME|NOTE):?\s*$/, // markers without text
  /^\[\[.+\]\]$/, // only wikilink, no surrounding text
  /^!\[.*\]\(.+\)$/, // only image embed
];

function shouldSkipChunk(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length < config.chunkMinLength || SKIP_PATTERNS.some((p) => p.test(trimmed));
}

/**
 * Return the estimated token weight for a single Unicode code point.
 * These coefficients are derived from empirical tokenization ratios of
 * common embedding-model tokenizers (cl100k_base, SentencePiece, WordPiece).
 * They are intentionally conservative: over-estimation causes more chunks
 * (safe), under-estimation causes oversized chunks that get rejected by APIs.
 */
function charTokenWeight(cp: number): number {
  if (cp <= 127) {
    return 0.25; // ASCII
  }
  // Hangul Syllables + Jamo + Compatibility Jamo
  if (
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0x1100 && cp <= 0x11ff) ||
    (cp >= 0x3130 && cp <= 0x318f)
  ) {
    return 1.5;
  }
  // CJK Unified Ideographs (common + extension A) + Compatibility Ideographs
  if (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0xf900 && cp <= 0xfaff)
  ) {
    return 1.4;
  }
  // Hiragana / Katakana / Halfwidth Katakana
  if (
    (cp >= 0x3040 && cp <= 0x309f) ||
    (cp >= 0x30a0 && cp <= 0x30ff) ||
    (cp >= 0xff65 && cp <= 0xff9f)
  ) {
    return 1.3;
  }
  // Thai — poor vocab coverage, heavy byte-fallback
  if (cp >= 0x0e00 && cp <= 0x0e7f) {
    return 1.8;
  }
  // Devanagari (Hindi, Sanskrit, etc.)
  if (cp >= 0x0900 && cp <= 0x097f) {
    return 1.4;
  }
  // Arabic
  if (cp >= 0x0600 && cp <= 0x06ff) {
    return 1.2;
  }
  // Hebrew
  if (cp >= 0x0590 && cp <= 0x05ff) {
    return 1.2;
  }
  // Cyrillic — decent coverage, ~0.7 real but keep 1.0 as conservative fallback
  if (cp >= 0x0400 && cp <= 0x04ff) {
    return 1.0;
  }
  // General non-ASCII fallback
  return 1.0;
}

export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const char of text) {
    tokens += charTokenWeight(char.codePointAt(0)!);
  }
  return Math.ceil(tokens);
}

interface Section {
  heading: string;
  headingChain: string[];
  body: string;
  text: string;
  charStart: number; // position of the heading line (or 0 for pre-heading body)
  charEnd: number;
}

export function splitBySections(content: string): Section[] {
  const lines = content.split('\n');
  const sections: Section[] = [];
  let currentHeading = '';
  let currentHeadingChain: string[] = [];
  let currentBody: string[] = [];
  // Slots for H1–H6; null means "not set at this level"
  const headingSlots: (string | null)[] = [null, null, null, null, null, null];
  let pos = 0;
  let currentSectionStart = 0;

  const flush = () => {
    const body = currentBody.join('\n');
    if (!shouldSkipChunk(body)) {
      const text = currentHeading ? `${currentHeading}\n${body}`.trim() : body.trim();
      sections.push({
        heading: currentHeading,
        headingChain: currentHeadingChain,
        body,
        text,
        charStart: currentSectionStart,
        charEnd: Math.min(pos, content.length),
      });
    }
    currentBody = [];
  };

  let insideCodeFence = false;

  for (const line of lines) {
    // Track fenced code blocks (``` or ~~~) so we don't misread # comments as headings
    if (/^(`{3,}|~{3,})/.test(line)) {
      insideCodeFence = !insideCodeFence;
      currentBody.push(line);
      pos += line.length + 1;
      continue;
    }

    const match = !insideCodeFence ? /^(#{1,6})\s+/.exec(line) : null;
    if (match) {
      flush();
      currentSectionStart = pos;
      currentHeading = line;
      const level = match[1]!.length; // 1–6
      headingSlots[level - 1] = line;
      // Clear all deeper levels so they don't bleed into sibling sections
      for (let i = level; i < 6; i++) headingSlots[i] = null;
      currentHeadingChain = headingSlots.filter((s): s is string => s !== null);
    } else {
      currentBody.push(line);
    }
    pos += line.length + 1;
  }
  flush();

  return sections;
}

/**
 * Advance `start` position in `text` by up to `budget` tokens worth of
 * characters. Returns the number of characters stepped (always ≥ 1 to
 * guarantee forward progress).
 */
function advanceByTokenBudget(text: string, start: number, budget: number): number {
  let stepped = 0;
  let accum = 0;
  while (stepped < text.length - start) {
    const cp = text.codePointAt(start + stepped)!;
    const nextAccum = accum + charTokenWeight(cp);
    if (Math.ceil(nextAccum) > budget) {
      // Ensure we always advance by at least one character to prevent
      // an infinite loop when a single character exceeds the budget.
      if (stepped === 0) stepped += cp > 0xffff ? 2 : 1;
      break;
    }
    accum = nextAccum;
    stepped += cp > 0xffff ? 2 : 1;
  }
  return stepped;
}

export function slidingWindow(
  text: string,
  contextLength: number,
  overlap: number,
  headingChain: string[] = [],
  sectionOffset = 0,
): Chunk[] {
  const stepTokens = Math.max(contextLength - overlap, Math.ceil(contextLength / 2));
  const chunks: Chunk[] = [];

  let start = 0;
  while (start < text.length) {
    // Advance char by char until we reach contextLength tokens
    let end = start;
    let tokens = 0;
    while (end < text.length) {
      const cp = text.codePointAt(end)!;
      const nextTokens = tokens + charTokenWeight(cp);
      if (Math.ceil(nextTokens) > contextLength) break;
      tokens = nextTokens;
      end += cp > 0xffff ? 2 : 1;
    }

    const chunk = createSourceChunk(text, start, end, headingChain, sectionOffset);
    if (!shouldSkipChunk(chunk.text)) {
      chunks.push(chunk);
    }
    if (end >= text.length) break;

    start += advanceByTokenBudget(text, start, stepTokens);
  }

  return chunks.length > 0
    ? chunks
    : [createSourceChunk(text, 0, text.length, headingChain, sectionOffset)];
}

/**
 * Build a DOM-matchable string from chunk text.
 * Strips heading lines and markdown syntax so the result matches
 * the textContent of a rendered DOM block.
 * Truncated to 80 characters.
 */
export function buildMatchText(chunkText: string): string {
  const lines = chunkText.split('\n');
  // Skip heading lines and everything inside fenced code blocks
  const bodyLines: string[] = [];
  let inCode = false;
  for (const l of lines) {
    if (/^```/.test(l.trimStart())) {
      inCode = !inCode;
      continue;
    }
    if (inCode || /^#{1,6}\s/.test(l.trimStart())) continue;
    bodyLines.push(l);
  }
  const fallback = (lines[0] ?? '').replace(/^#{1,6}\s+/, '');

  // Iterate lines until one yields non-empty text after stripping markdown.
  // This skips e.g. callout type-only lines ("> [!quote]" strips to "").
  for (const line of [...bodyLines, fallback]) {
    if (!line.trim()) continue;
    const stripped = stripMarkdownImages(
      stripHtmlTags(stripLeadingBlockquoteCallout(line)) // blockquote/callout markers and HTML tags
        .replace(/\[\^[^\]]+\]/g, '') // footnote references ([^1])
        .replace(/!\[\[[^\]]+\]\]/g, ''), // embed wikilinks ![[Note]] → strip entirely
    );
    const result = replaceMarkdownInlineLinks(replaceWikilinkLabels(stripped))
      .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, '$1') // bold / italic
      .replace(/`([^`]+)`/g, '$1') // inline code
      .replace(/^(?:[-*+]|\d+[.)]) \s*/m, '') // list markers
      .replace(/^\[[xX ]\]\s*/m, '') // task checkboxes
      .trim();
    if (result) return result.slice(0, 80);
  }
  return '';
}

function stripLeadingBlockquoteCallout(value: string): string {
  let index = stripLeadingQuoteMarkers(value, 0);
  if (value.startsWith('[!', index)) {
    const calloutEnd = value.indexOf(']', index + 2);
    if (calloutEnd !== -1) {
      index = skipWhitespace(value, calloutEnd + 1);
      index = stripLeadingQuoteMarkers(value, index);
    }
  }
  return value.slice(index);
}

function stripLeadingQuoteMarkers(value: string, start: number): number {
  let index = start;
  while (value[index] === '>') {
    index = skipWhitespace(value, index + 1);
  }
  return index;
}

function skipWhitespace(value: string, start: number): number {
  let index = start;
  while (index < value.length && isWhitespace(value[index]!)) index++;
  return index;
}

function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function trimSourceBounds(source: string, rawStart: number, rawEnd: number): [number, number] {
  let start = Math.max(0, Math.min(rawStart, source.length));
  let end = Math.max(start, Math.min(rawEnd, source.length));

  while (start < end && isWhitespace(source[start]!)) start++;
  while (end > start && isWhitespace(source[end - 1]!)) end--;

  if (start > 0 && isLowSurrogate(source.charCodeAt(start))) start--;
  if (end < source.length && isLowSurrogate(source.charCodeAt(end))) end++;

  return [start, end];
}

function createSourceChunk(
  source: string,
  rawStart: number,
  rawEnd: number,
  headingChain: string[],
  sourceOffset = 0,
): Chunk {
  const [start, end] = trimSourceBounds(source, rawStart, rawEnd);
  return {
    text: source.slice(start, end),
    headingChain,
    charStart: sourceOffset + start,
    charEnd: sourceOffset + end,
  };
}

function canSplitAt(source: string, position: number): boolean {
  if (position <= 0 || position >= source.length) return false;
  if (isLowSurrogate(source.charCodeAt(position))) return false;
  return source[position - 1] !== '\r' || source[position] !== '\n';
}

function addBoundary(
  source: string,
  priorities: Map<number, number>,
  position: number,
  priority: number,
): void {
  if (!canSplitAt(source, position)) return;
  priorities.set(position, Math.max(priorities.get(position) ?? 0, priority));
}

function collectLineBoundaries(source: string, priorities: Map<number, number>): void {
  let lineStart = 0;
  while (lineStart < source.length) {
    const newline = source.indexOf('\n', lineStart);
    const rawLineEnd = newline === -1 ? source.length : newline;
    const lineEnd =
      rawLineEnd > lineStart && source[rawLineEnd - 1] === '\r' ? rawLineEnd - 1 : rawLineEnd;
    const line = source.slice(lineStart, lineEnd);

    if (/^\s*\[[^\]\r\n]+\]:\s+/.test(line)) {
      addBoundary(source, priorities, lineStart, BOUNDARY_PRIORITY.REFERENCE);
    } else if (/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>|\|)/.test(line)) {
      addBoundary(source, priorities, lineStart, BOUNDARY_PRIORITY.MARKDOWN_LINE);
    }
    addBoundary(source, priorities, lineEnd, BOUNDARY_PRIORITY.LINE_END);

    if (newline === -1) break;
    lineStart = newline + 1;
  }
}

function collectStructuralBoundaries(source: string, priorities: Map<number, number>): void {
  const blankLine = /\r?\n[ \t]*\r?\n/g;
  for (const match of source.matchAll(blankLine)) {
    addBoundary(source, priorities, match.index, BOUNDARY_PRIORITY.BLANK_LINE);
  }

  const sentenceEnd = /[.!?]["')\]]*(?=\s|$)/g;
  for (const match of source.matchAll(sentenceEnd)) {
    addBoundary(source, priorities, match.index + match[0].length, BOUNDARY_PRIORITY.SENTENCE);
  }
}

function collectBoundaries(source: string): Boundary[] {
  const priorities = new Map<number, number>();
  let position = 0;
  while (position < source.length) {
    const codePoint = source.codePointAt(position)!;
    position += codePoint > 0xffff ? 2 : 1;
    addBoundary(source, priorities, position, BOUNDARY_PRIORITY.CODE_POINT);
  }

  for (let index = 0; index < source.length; index++) {
    if (isWhitespace(source[index]!)) {
      addBoundary(source, priorities, index, BOUNDARY_PRIORITY.WHITESPACE);
    }
  }
  collectLineBoundaries(source, priorities);
  collectStructuralBoundaries(source, priorities);

  return [...priorities]
    .map(([boundaryPosition, priority]) => ({ position: boundaryPosition, priority }))
    .sort((left, right) => left.position - right.position);
}

function lowerBoundaryIndex(boundaries: readonly Boundary[], position: number): number {
  let low = 0;
  let high = boundaries.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (boundaries[middle]!.position < position) low = middle + 1;
    else high = middle;
  }
  return low;
}

function alignExistingChunk(source: string, chunk: Chunk): { chunk: Chunk; aligned: boolean } {
  if (
    chunk.charStart >= 0 &&
    chunk.charEnd >= chunk.charStart &&
    chunk.charEnd <= source.length &&
    source.slice(chunk.charStart, chunk.charEnd) === chunk.text
  ) {
    return { chunk, aligned: true };
  }

  const searchStart = Math.max(0, Math.min(chunk.charStart, source.length));
  const locatedStart = source.indexOf(chunk.text, searchStart);
  if (locatedStart === -1) return { chunk, aligned: false };
  return {
    chunk: {
      ...chunk,
      charStart: locatedStart,
      charEnd: locatedStart + chunk.text.length,
    },
    aligned: true,
  };
}

function chooseInitialFittingBoundary(
  source: string,
  headingChain: string[],
  limit: number,
  countProjected: ProjectedTokenCounter,
  boundaries: readonly Boundary[],
  firstIndex: number,
  lastIndex: number,
  start: number,
): { index: number; counts: Map<number, number> } {
  const counts = new Map<number, number>();
  const countAt = (index: number): number => {
    const position = boundaries[index]!.position;
    const cached = counts.get(position);
    if (cached !== undefined) return cached;
    const candidate = createSourceChunk(source, start, position, headingChain);
    const count = countProjected(candidate.text, headingChain);
    counts.set(position, count);
    return count;
  };

  let low = firstIndex;
  let high = lastIndex;
  let fittingIndex = -1;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    if (countAt(middle) <= limit) {
      fittingIndex = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  while (fittingIndex >= firstIndex && countAt(fittingIndex) > limit) fittingIndex--;
  return { index: fittingIndex, counts };
}

function choosePreferredBoundary(
  source: string,
  headingChain: string[],
  limit: number,
  countProjected: ProjectedTokenCounter,
  boundaries: readonly Boundary[],
  firstIndex: number,
  fittingIndex: number,
  start: number,
  counts: Map<number, number>,
): number {
  const fittingPosition = boundaries[fittingIndex]!.position;
  const preferredStart = start + Math.floor((fittingPosition - start) * 0.8);
  const preferredIndex = Math.max(firstIndex, lowerBoundaryIndex(boundaries, preferredStart));
  let highestPriority: number = BOUNDARY_PRIORITY.CODE_POINT;
  for (let index = preferredIndex; index <= fittingIndex; index++) {
    highestPriority = Math.max(highestPriority, boundaries[index]!.priority);
  }

  for (let priority = highestPriority; priority >= BOUNDARY_PRIORITY.CODE_POINT; priority--) {
    for (let index = fittingIndex; index >= preferredIndex; index--) {
      const boundary = boundaries[index]!;
      if (boundary.priority !== priority) continue;
      let count = counts.get(boundary.position);
      if (count === undefined) {
        const candidate = createSourceChunk(source, start, boundary.position, headingChain);
        count = countProjected(candidate.text, headingChain);
        counts.set(boundary.position, count);
      }
      if (count <= limit) return index;
    }
  }
  return fittingIndex;
}

function nextSafeStart(source: string, proposed: number, end: number): number {
  let position = Math.min(proposed, end);
  if (position < end && isLowSurrogate(source.charCodeAt(position))) position++;
  if (position < end && source[position - 1] === '\r' && source[position] === '\n') position++;
  return position;
}

function refineAlignedChunk(
  source: string,
  chunk: Chunk,
  limit: number,
  countProjected: ProjectedTokenCounter,
  overlap: number,
  boundaries: readonly Boundary[],
): Chunk[] {
  if (countProjected(chunk.text, chunk.headingChain) <= limit) return [chunk];

  const refined: Chunk[] = [];
  let start = chunk.charStart;
  while (start < chunk.charEnd) {
    const remainder = createSourceChunk(source, start, chunk.charEnd, chunk.headingChain);
    if (countProjected(remainder.text, chunk.headingChain) <= limit) {
      if (remainder.text.length > 0) refined.push(remainder);
      break;
    }

    const firstIndex = lowerBoundaryIndex(boundaries, start + 1);
    const endIndex = lowerBoundaryIndex(boundaries, chunk.charEnd);
    if (firstIndex >= endIndex) {
      refined.push(remainder);
      break;
    }
    const lastIndex = Math.max(firstIndex, endIndex - 1);
    const initial = chooseInitialFittingBoundary(
      source,
      chunk.headingChain,
      limit,
      countProjected,
      boundaries,
      firstIndex,
      lastIndex,
      start,
    );
    const fittingIndex = initial.index === -1 ? firstIndex : initial.index;
    const chosenIndex =
      initial.index === -1
        ? fittingIndex
        : choosePreferredBoundary(
            source,
            chunk.headingChain,
            limit,
            countProjected,
            boundaries,
            firstIndex,
            fittingIndex,
            start,
            initial.counts,
          );
    const chosenEnd = boundaries[chosenIndex]!.position;
    const child = createSourceChunk(source, start, chosenEnd, chunk.headingChain);
    if (child.text.length > 0) refined.push(child);
    if (chosenEnd >= chunk.charEnd) break;

    const span = chosenEnd - start;
    const boundedOverlap = Math.min(Math.max(0, Math.floor(overlap)), Math.max(0, span - 1));
    const nextStart = nextSafeStart(source, chosenEnd - boundedOverlap, chosenEnd);
    if (nextStart <= start) throw new Error('Chunk refinement failed to make progress');
    start = nextStart;
  }
  return refined;
}

export function refineChunksToFit(
  source: string,
  chunks: readonly Chunk[],
  limit: number,
  countProjected: ProjectedTokenCounter,
  overlap: number,
): Chunk[] {
  const boundaries = collectBoundaries(source);
  const refined: Chunk[] = [];
  for (const inputChunk of chunks) {
    const aligned = alignExistingChunk(source, inputChunk);
    if (!aligned.aligned || aligned.chunk.text.length === 0) {
      refined.push(aligned.chunk);
      continue;
    }
    refined.push(
      ...refineAlignedChunk(source, aligned.chunk, limit, countProjected, overlap, boundaries),
    );
  }
  return refined;
}

function validRetrySplit(source: string, chunk: Chunk, position: number): [Chunk, Chunk] | null {
  const left = createSourceChunk(source, chunk.charStart, position, chunk.headingChain);
  const right = createSourceChunk(source, position, chunk.charEnd, chunk.headingChain);
  if (left.text.length === 0 || right.text.length === 0) return null;
  if (left.charEnd - left.charStart >= chunk.charEnd - chunk.charStart) return null;
  if (right.charEnd - right.charStart >= chunk.charEnd - chunk.charStart) return null;
  return [left, right];
}

export function splitChunkForRetry(source: string, inputChunk: Chunk): [Chunk, Chunk] | null {
  const aligned = alignExistingChunk(source, inputChunk);
  if (!aligned.aligned) return null;
  const chunk = aligned.chunk;
  const boundaries = collectBoundaries(source);
  const firstIndex = lowerBoundaryIndex(boundaries, chunk.charStart + 1);
  const endIndex = lowerBoundaryIndex(boundaries, chunk.charEnd);
  if (firstIndex >= endIndex) return null;

  const midpoint = chunk.charStart + (chunk.charEnd - chunk.charStart) / 2;
  const candidates = boundaries.slice(firstIndex, endIndex).sort((left, right) => {
    const leftNatural = left.priority > BOUNDARY_PRIORITY.CODE_POINT ? 0 : 1;
    const rightNatural = right.priority > BOUNDARY_PRIORITY.CODE_POINT ? 0 : 1;
    return (
      leftNatural - rightNatural ||
      Math.abs(left.position - midpoint) - Math.abs(right.position - midpoint) ||
      right.priority - left.priority
    );
  });

  for (const candidate of candidates) {
    const split = validRetrySplit(source, chunk, candidate.position);
    if (split) return split;
  }
  return null;
}

function stripHtmlTags(value: string): string {
  let result = '';
  let index = 0;
  while (index < value.length) {
    if (value[index] !== '<') {
      result += value[index];
      index++;
      continue;
    }
    const end = value.indexOf('>', index + 1);
    if (end === -1) {
      result += value.slice(index);
      break;
    }
    index = end + 1;
  }
  return result;
}

function stripMarkdownImages(value: string): string {
  let result = '';
  let index = 0;
  while (index < value.length) {
    if (!value.startsWith('![', index)) {
      result += value[index];
      index++;
      continue;
    }

    const labelEnd = value.indexOf(']', index + 2);
    if (labelEnd === -1 || value[labelEnd + 1] !== '(') {
      result += value[index];
      index++;
      continue;
    }
    const destinationEnd = value.indexOf(')', labelEnd + 2);
    if (destinationEnd === -1) {
      result += value[index];
      index++;
      continue;
    }
    index = destinationEnd + 1;
  }
  return result;
}

function replaceWikilinkLabels(value: string): string {
  let result = '';
  let index = 0;
  while (index < value.length) {
    const start = value.indexOf('[[', index);
    if (start === -1) {
      result += value.slice(index);
      break;
    }

    const end = value.indexOf(']]', start + 2);
    if (end === -1) {
      result += value.slice(index);
      break;
    }

    result += value.slice(index, start);
    const inner = value.slice(start + 2, end);
    const aliasIndex = inner.indexOf('|');
    result += aliasIndex === -1 ? inner : inner.slice(aliasIndex + 1);
    index = end + 2;
  }
  return result;
}

function replaceMarkdownInlineLinks(value: string): string {
  let result = '';
  let index = 0;
  while (index < value.length) {
    const labelStart = value.indexOf('[', index);
    if (labelStart === -1) {
      result += value.slice(index);
      break;
    }

    const labelEnd = value.indexOf(']', labelStart + 1);
    if (labelEnd === -1 || value[labelEnd + 1] !== '(') {
      result += value.slice(index, labelStart + 1);
      index = labelStart + 1;
      continue;
    }

    const destinationEnd = value.indexOf(')', labelEnd + 2);
    if (destinationEnd === -1) {
      result += value.slice(index, labelStart + 1);
      index = labelStart + 1;
      continue;
    }

    result += value.slice(index, labelStart);
    result += value.slice(labelStart + 1, labelEnd);
    index = destinationEnd + 1;
  }
  return result;
}

export function chunkNote(content: string, contextLength: number): Chunk[] {
  if (estimateTokens(content) <= contextLength) {
    return [createSourceChunk(content, 0, content.length, [])];
  }

  const sections = splitBySections(content);

  if (sections.length <= 1) {
    return slidingWindow(content, contextLength, config.chunkOverlap, [], 0);
  }

  const chunks: Chunk[] = [];
  for (const section of sections) {
    if (shouldSkipChunk(section.body)) continue;
    const sectionSource = content.slice(section.charStart, section.charEnd);
    if (estimateTokens(sectionSource) <= contextLength) {
      chunks.push(
        createSourceChunk(content, section.charStart, section.charEnd, section.headingChain),
      );
    } else {
      chunks.push(
        ...slidingWindow(
          sectionSource,
          contextLength,
          config.chunkOverlap,
          section.headingChain,
          section.charStart,
        ),
      );
    }
  }

  return chunks.length > 0 ? chunks : [createSourceChunk(content, 0, content.length, [])];
}
