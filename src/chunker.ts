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

export function estimateTokens(text: string): number {
  // Cyrillic and other non-ASCII scripts: ~1 char per token
  // ASCII (English): ~4 chars per token
  let tokens = 0;
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    if (cp > 127) {
      tokens += 1; // non-ASCII (Cyrillic, CJK, etc.)
    } else {
      tokens += 0.25; // ASCII
    }
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
    while (end < text.length && tokens < contextLength) {
      const cp = text.codePointAt(end)!;
      tokens += cp > 127 ? 1 : 0.25;
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

    // Advance start by stepTokens worth of chars
    let stepped = 0;
    let stepTokensAccum = 0;
    while (stepped < text.length - start && stepTokensAccum < stepTokens) {
      const cp = text.codePointAt(start + stepped)!;
      stepTokensAccum += cp > 127 ? 1 : 0.25;
      stepped += cp > 0xffff ? 2 : 1;
    }
    start += stepped;
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
  // Skip leading heading lines (e.g. "## Creating Notes")
  const bodyLines = lines.filter((l) => !/^#{1,6}\s/.test(l.trimStart()));
  const fallback = (lines[0] ?? '').replace(/^#{1,6}\s+/, '');
  const raw = (bodyLines.find((l) => l.trim().length > 0) ?? fallback).trim();

  return raw
    .replace(/^(?:>\s*)+(?:\[![^\]]*\]\s*)?/, '') // strip blockquote/callout markers ("> [!type] " or "> ")
    .replace(/!\[.*?\]\(.*?\)/g, '') // images
    .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1') // [[wikilinks]] → text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [links](url) → text
    .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, '$1') // bold / italic
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/^(?:[-*+]|\d+[.)]) \s*/m, '') // list markers
    .replace(/^\[[xX ]\]\s*/m, '') // task checkboxes
    .trim()
    .slice(0, 80);
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
