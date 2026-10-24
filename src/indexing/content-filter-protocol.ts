import type { ContentIgnorePattern, ContentProjection } from '../content/content-ignore.js';

export type ContentFilterRequest =
  | { id: number; type: 'init'; patterns: readonly ContentIgnorePattern[] }
  | { id: number; type: 'project'; body: string };

export type ContentFilterReply =
  { id: number; ok: true; projection?: ContentProjection } | { id: number; ok: false };

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

export function isContentFilterRequest(value: unknown): value is ContentFilterRequest {
  if (!object(value) || !Number.isSafeInteger(value.id)) return false;
  if (value.type === 'project') return typeof value.body === 'string';
  return (
    value.type === 'init' &&
    Array.isArray(value.patterns) &&
    value.patterns.every(
      (pattern: unknown) =>
        object(pattern) && typeof pattern.source === 'string' && typeof pattern.flags === 'string',
    )
  );
}

export function isContentProjection(value: unknown, source: string): value is ContentProjection {
  if (!object(value) || typeof value.text !== 'string' || value.text.length > source.length) {
    return false;
  }
  if (value.segments === null) return value.text === source;
  if (!Array.isArray(value.segments)) return false;
  let textEnd = 0;
  let sourceEnd = 0;
  for (const segment of value.segments as unknown[]) {
    if (!object(segment)) return false;
    const start = segment.sourceStart;
    const end = segment.sourceEnd;
    const nextTextEnd = segment.textEnd;
    if (
      typeof start !== 'number' ||
      typeof end !== 'number' ||
      typeof nextTextEnd !== 'number' ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      !Number.isSafeInteger(nextTextEnd) ||
      start < sourceEnd ||
      end <= start ||
      end > source.length ||
      segment.textStart !== textEnd ||
      nextTextEnd <= textEnd ||
      nextTextEnd > value.text.length
    )
      return false;
    if (segment.separator !== undefined) {
      if (
        (segment.separator !== ' ' && segment.separator !== '\n') ||
        nextTextEnd !== textEnd + 1 ||
        value.text[textEnd] !== segment.separator
      )
        return false;
    } else if (
      nextTextEnd - textEnd !== end - start ||
      value.text.slice(textEnd, nextTextEnd) !== source.slice(start, end)
    )
      return false;
    textEnd = nextTextEnd;
    sourceEnd = end;
  }
  return textEnd === value.text.length;
}
