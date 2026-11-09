import matter from 'gray-matter';

function assertDataOnlyFrontmatter(raw: string): void {
  // gray-matter strips a BOM and lets the opening delimiter select an engine.
  // `language: 'yaml'` and `eval: false` do not disable its JavaScript evaluator.
  const source = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  if (!matter.test(source) || source[3] === '-') return;
  const language = matter.language(source).name.toLowerCase();
  if (language && !['yaml', 'yml', 'json'].includes(language)) {
    throw new Error('Unsupported frontmatter language; use YAML or JSON');
  }
}

function rejectExecutableFrontmatter(): never {
  throw new Error('Executable frontmatter is not supported; use YAML or JSON');
}

function assertBoundedFrontmatter(frontmatter: unknown, sourceLength: number): void {
  if (frontmatter === null || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    throw new Error('Markdown frontmatter must be a YAML or JSON object');
  }
  // Safe YAML parsing preserves alias references, but later String/JSON conversions
  // can expand them exponentially. Measure the graph without expanding shared nodes.
  const budget = Math.max(1_000_000, sourceLength * 4);
  const active = new WeakSet<object>();
  type Measurement = { size: number; height: number };
  const measurements = new WeakMap<object, Measurement>();
  const measure = (value: unknown, depth: number): Measurement => {
    // Heights count nested containers; scalars contribute no additional nesting.
    if (typeof value === 'string') return { size: value.length + 2, height: -1 };
    if (value === null || typeof value !== 'object') return { size: 8, height: -1 };
    if (value instanceof Date) return { size: 26, height: -1 };
    if (ArrayBuffer.isView(value)) return { size: value.byteLength * 4, height: -1 };
    if (active.has(value)) throw new Error('Cyclic frontmatter aliases are not supported');
    if (depth > 128) throw new Error('Markdown frontmatter nesting exceeds 128 levels');
    const cached = measurements.get(value);
    if (cached !== undefined) {
      // A shallow anchor may be reused much deeper in the expanded document.
      if (depth + cached.height > 128)
        throw new Error('Markdown frontmatter nesting exceeds 128 levels');
      return cached;
    }
    active.add(value);
    let size = 2;
    let height = 0;
    for (const [key, child] of Object.entries(value)) {
      const measuredChild = measure(child, depth + 1);
      size += key.length + 4 + measuredChild.size;
      height = Math.max(height, measuredChild.height + 1);
      if (size > budget) throw new Error('Markdown frontmatter alias expansion is too large');
    }
    active.delete(value);
    const result = { size, height };
    measurements.set(value, result);
    return result;
  };
  measure(frontmatter, 0);
}

export function extractMarkdownNote(raw: string, fallbackTitle: string) {
  assertDataOnlyFrontmatter(raw);
  let parsed: matter.GrayMatterFile<string>;
  try {
    // Passing options also bypasses a content cache that loses the raw `matter` field.
    // Keep an explicit engine rejection in addition to validating the language label.
    parsed = matter(raw, { engines: { javascript: rejectExecutableFrontmatter } });
  } catch (error) {
    throw new Error('Invalid Markdown frontmatter', {
      // eslint-disable-next-line preserve-caught-error -- Parser causes include private source excerpts.
      cause: { name: error instanceof Error ? error.name : 'ParseError' },
    });
  }
  const { data: frontmatter, content } = parsed;
  const frontmatterRaw: string = parsed.matter ?? '';
  assertBoundedFrontmatter(frontmatter, frontmatterRaw.length);
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
 * a Unicode letter/underscore, then letters, marks, digits, underscores, hyphens, or slashes.
 */
export function parseInlineTags(content: string): string[] {
  const seen = new Set<string>();
  // Strip code blocks to avoid matching # inside them
  const stripped = content.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
  for (const match of stripped.matchAll(/(?:^|[\s,;(])#([\p{L}_][\p{L}\p{M}\p{Nd}_\-/]*)/gmu)) {
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
