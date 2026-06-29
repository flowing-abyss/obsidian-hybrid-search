import { config } from './config.js';

interface Chunk {
  text: string;
  headingChain: string[];
  charStart: number;
  charEnd: number;
}

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

    const chunk = text.slice(start, end).trim();
    if (!shouldSkipChunk(chunk)) {
      chunks.push({
        text: chunk,
        headingChain,
        charStart: sectionOffset + start,
        charEnd: sectionOffset + end,
      });
    }
    if (end >= text.length) break;

    start += advanceByTokenBudget(text, start, stepTokens);
  }

  return chunks.length > 0
    ? chunks
    : [
        {
          text: text.trim(),
          headingChain,
          charStart: sectionOffset,
          charEnd: sectionOffset + text.length,
        },
      ];
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
    return [{ text: content.trim(), headingChain: [], charStart: 0, charEnd: content.length }];
  }

  const sections = splitBySections(content);

  if (sections.length <= 1) {
    return slidingWindow(content, contextLength, config.chunkOverlap, [], 0);
  }

  const chunks: Chunk[] = [];
  for (const section of sections) {
    if (shouldSkipChunk(section.body)) continue;
    if (estimateTokens(section.text) <= contextLength) {
      chunks.push({
        text: section.text,
        headingChain: section.headingChain,
        charStart: section.charStart,
        charEnd: section.charStart + section.text.length,
      });
    } else {
      chunks.push(
        ...slidingWindow(
          section.text,
          contextLength,
          config.chunkOverlap,
          section.headingChain,
          section.charStart,
        ),
      );
    }
  }

  return chunks.length > 0
    ? chunks
    : [{ text: content.trim(), headingChain: [], charStart: 0, charEnd: content.length }];
}
