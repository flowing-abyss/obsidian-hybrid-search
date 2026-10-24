import matter from 'gray-matter';

export function extractMarkdownNote(raw: string, fallbackTitle: string) {
  // Its content cache drops the non-enumerable `matter` property on repeated reads.
  const parsed = matter(raw, {});
  const { data: frontmatter, content } = parsed;
  const frontmatterRaw: string = parsed.matter ?? '';
  const title = frontmatter.title == null ? fallbackTitle : String(frontmatter.title);
  const tags = extractNoteTags(content, frontmatter);
  const aliases = parseAliasField(frontmatter.aliases as unknown);

  return { frontmatter, content, frontmatterRaw, title, tags, aliases };
}

export function extractNoteTags(content: string, frontmatter: Record<string, unknown>): string[] {
  const frontmatterTags: string[] = Array.isArray(frontmatter.tags)
    ? frontmatter.tags.map(String)
    : typeof frontmatter.tags === 'string'
      ? frontmatter.tags.split(',').map((t: string) => t.trim())
      : [];
  const inlineTags = parseInlineTags(content);
  return [...new Set([...frontmatterTags, ...inlineTags])];
}

/**
 * Parse the `aliases` field from gray-matter frontmatter.
 * Handles three formats emitted by Obsidian:
 *   1. YAML list  → gray-matter produces a JS array
 *   2. JSON-stringified array → gray-matter produces a string like '["a","b"]'
 *   3. Plain string → single alias
 */
export function parseAliasField(raw: unknown): string[] {
  const nonempty = (s: string) => s.trim().length > 0;
  if (Array.isArray(raw)) return raw.map(String).filter(nonempty);
  if (typeof raw !== 'string' || !raw.trim()) return [];
  const trimmed = raw.trim();
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed.map(String).filter(nonempty);
  } catch {
    // not valid JSON — treat as a single alias
  }
  return [trimmed];
}

/**
 * Extract inline tags from note body: #tag, #tag/subtag
 * Matches # preceded by start-of-string or whitespace, followed by
 * a letter/underscore and then any word chars, hyphens, or slashes.
 */
export function parseInlineTags(content: string): string[] {
  const seen = new Set<string>();
  // Strip code blocks to avoid matching # inside them
  const stripped = content.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
  for (const match of stripped.matchAll(
    /(?:^|[\s,;(])#([a-zA-Z_\u00C0-\u024F][a-zA-Z0-9_\-/\u00C0-\u024F]*)/gm,
  )) {
    seen.add(match[1]!);
  }
  return [...seen];
}

export function parseWikilinks(content: string): string[] {
  const seen = new Set<string>();
  let index = 0;
  while (index < content.length) {
    const start = content.indexOf('[[', index);
    if (start === -1) break;
    const end = content.indexOf(']]', start + 2);
    if (end === -1) break;

    const inner = content.slice(start + 2, end);
    const pipeIndex = inner.indexOf('|');
    const headingIndex = inner.indexOf('#');
    const targetEnd = minPositiveIndex(pipeIndex, headingIndex, inner.length);
    const target = inner.slice(0, targetEnd).trim();
    if (target) seen.add(target);
    index = end + 2;
  }
  return [...seen];
}

function minPositiveIndex(first: number, second: number, fallback: number): number {
  const indexes = [first, second].filter((candidate) => candidate >= 0);
  return indexes.length > 0 ? Math.min(...indexes) : fallback;
}
