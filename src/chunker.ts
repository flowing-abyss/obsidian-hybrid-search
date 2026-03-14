import { config } from './config.js';

interface Chunk {
  text: string;
  headingChain: string[];
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
}

export function splitBySections(content: string): Section[] {
  const lines = content.split('\n');
  const sections: Section[] = [];
  let currentHeading = '';
  let currentHeadingChain: string[] = [];
  let currentBody: string[] = [];
  // Slots for H1–H6; null means "not set at this level"
  const headingSlots: (string | null)[] = [null, null, null, null, null, null];

  const flush = () => {
    const body = currentBody.join('\n');
    if (body.trim().length >= config.chunkMinLength) {
      const text = currentHeading ? `${currentHeading}\n${body}`.trim() : body.trim();
      sections.push({ heading: currentHeading, headingChain: currentHeadingChain, body, text });
    }
    currentBody = [];
  };

  let insideCodeFence = false;

  for (const line of lines) {
    // Track fenced code blocks (``` or ~~~) so we don't misread # comments as headings
    if (/^(`{3,}|~{3,})/.test(line)) {
      insideCodeFence = !insideCodeFence;
      currentBody.push(line);
      continue;
    }

    const match = !insideCodeFence ? /^(#{1,6})\s+/.exec(line) : null;
    if (match) {
      flush();
      currentHeading = line;
      const level = match[1]!.length; // 1–6
      headingSlots[level - 1] = line;
      // Clear all deeper levels so they don't bleed into sibling sections
      for (let i = level; i < 6; i++) headingSlots[i] = null;
      currentHeadingChain = headingSlots.filter((s): s is string => s !== null);
    } else {
      currentBody.push(line);
    }
  }
  flush();

  return sections;
}

export function slidingWindow(
  text: string,
  contextLength: number,
  overlap: number,
  headingChain: string[] = [],
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
    if (chunk.length >= config.chunkMinLength) {
      chunks.push({ text: chunk, headingChain });
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

  return chunks.length > 0 ? chunks : [{ text: text.trim(), headingChain }];
}

export function chunkNote(content: string, contextLength: number): Chunk[] {
  if (estimateTokens(content) <= contextLength) {
    return [{ text: content.trim(), headingChain: [] }];
  }

  const sections = splitBySections(content);

  if (sections.length <= 1) {
    return slidingWindow(content, contextLength, config.chunkOverlap, []);
  }

  const chunks: Chunk[] = [];
  for (const section of sections) {
    if (section.body.trim().length < config.chunkMinLength) continue;
    if (estimateTokens(section.text) <= contextLength) {
      chunks.push({ text: section.text, headingChain: section.headingChain });
    } else {
      chunks.push(
        ...slidingWindow(section.text, contextLength, config.chunkOverlap, section.headingChain),
      );
    }
  }

  return chunks.length > 0
    ? chunks
    : slidingWindow(content, contextLength, config.chunkOverlap, []);
}
