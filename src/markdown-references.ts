import path from 'node:path';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';

interface DefinitionNode {
  type: 'definition';
  identifier?: string | null;
  url?: string;
}

interface AnyMarkdownNode {
  type?: string;
  url?: string;
  identifier?: string | null;
  label?: string | null;
  value?: string;
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
}

export interface MarkdownReferences {
  localDestinations: Array<{ destination: string }>;
  urls: string[];
}

export interface MarkdownLinkOccurrence {
  destination: string;
  startOffset: number;
  endOffset: number;
}

const HTTP_URL_RE = /https?:\/\/[^\s<>"']+/gi;
const TRAILING_PUNCTUATION_RE = /[.,;:!?]+$/;

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function hasScheme(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}

function normalizeReferenceId(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function stripBareUrlTrailingPunctuation(value: string): string {
  let next = value.replace(TRAILING_PUNCTUATION_RE, '');
  while (next.endsWith(')')) {
    const opens = (next.match(/\(/g) ?? []).length;
    const closes = (next.match(/\)/g) ?? []).length;
    if (closes <= opens) break;
    next = next.slice(0, -1);
  }
  return next.replace(/[”"']+$/g, '');
}

function pushUnique(values: string[], seen: Set<string>, value: string): void {
  if (!value || seen.has(value)) return;
  seen.add(value);
  values.push(value);
}

export function extractMarkdownReferences(content: string): MarkdownReferences {
  const references = extractMarkdownReferenceOccurrences(content);
  return {
    localDestinations: references.localDestinations.map((link) => ({
      destination: link.destination,
    })),
    urls: references.urls,
  };
}

export function extractMarkdownReferenceOccurrences(content: string): {
  localDestinations: MarkdownLinkOccurrence[];
  urls: string[];
} {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(content);
  const localDestinations: MarkdownLinkOccurrence[] = [];
  const urls: string[] = [];
  const seenUrls = new Set<string>();
  const seenLocal = new Set<string>();
  const definitions = new Map<string, string>();

  visit(tree, 'definition', (node: DefinitionNode) => {
    const id = normalizeReferenceId(node.identifier);
    const url = node.url?.trim();
    if (id && url && !definitions.has(id)) definitions.set(id, url);
  });

  const recordDestination = (
    destination: string,
    startOffset: number | undefined,
    endOffset: number | undefined,
  ): void => {
    if (isHttpUrl(destination)) {
      pushUnique(urls, seenUrls, destination);
      return;
    }
    if (hasScheme(destination)) return;
    if (
      !destination ||
      seenLocal.has(destination) ||
      startOffset === undefined ||
      endOffset === undefined
    ) {
      return;
    }
    seenLocal.add(destination);
    localDestinations.push({ destination, startOffset, endOffset });
  };

  visit(tree, (node) => {
    const markdownNode = node as AnyMarkdownNode;
    if (markdownNode.type === 'link') {
      const destination = markdownNode.url?.trim();
      if (destination) {
        recordDestination(
          destination,
          markdownNode.position?.start?.offset,
          markdownNode.position?.end?.offset,
        );
      }
      return;
    }
    if (markdownNode.type === 'linkReference') {
      const destination = definitions.get(
        normalizeReferenceId(markdownNode.identifier ?? markdownNode.label),
      );
      if (destination) {
        recordDestination(
          destination,
          markdownNode.position?.start?.offset,
          markdownNode.position?.end?.offset,
        );
      }
      return;
    }
    if (markdownNode.type === 'text') {
      const value = markdownNode.value ?? '';
      for (const match of value.matchAll(HTTP_URL_RE)) {
        const url = stripBareUrlTrailingPunctuation(match[0]);
        pushUnique(urls, seenUrls, url);
      }
    }
  });

  return {
    localDestinations,
    urls,
  };
}

function splitLocalDestination(raw: string): string {
  const hashIndex = raw.indexOf('#');
  const queryIndex = raw.indexOf('?');
  const cutIndexes = [hashIndex, queryIndex].filter((index) => index >= 0);
  const cutIndex = cutIndexes.length > 0 ? Math.min(...cutIndexes) : raw.length;
  return raw.slice(0, cutIndex).trim();
}

function safeDecodePath(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function isMarkdownPath(value: string): boolean {
  return path.posix.extname(value).toLowerCase() === '.md';
}

function hasAnyExtension(value: string): boolean {
  return path.posix.extname(value).length > 0;
}

function resolveCandidate(fromPath: string, rawDestination: string): string | null {
  const withoutFragment = splitLocalDestination(rawDestination);
  if (!withoutFragment || hasScheme(withoutFragment)) return null;
  const decoded = safeDecodePath(withoutFragment).replace(/\\/g, '/');
  const fromDir = path.posix.dirname(fromPath);
  const resolved = decoded.startsWith('/')
    ? path.posix.normalize(decoded.slice(1))
    : path.posix.normalize(path.posix.join(fromDir, decoded));
  if (!resolved || resolved === '.' || resolved === '..' || resolved.startsWith('../')) {
    return null;
  }
  return resolved.normalize('NFD');
}

export function resolveMarkdownNoteLinks(
  fromPath: string,
  destinations: readonly string[],
  existingNotePaths: ReadonlySet<string>,
): string[] {
  const normalizedFromPath = fromPath.normalize('NFD');
  const resolved: string[] = [];
  const seen = new Set<string>();

  for (const destination of destinations) {
    const candidate = resolveCandidate(normalizedFromPath, destination);
    if (!candidate) continue;
    const candidates = isMarkdownPath(candidate)
      ? [candidate]
      : hasAnyExtension(candidate)
        ? []
        : [candidate, `${candidate}.md`];
    for (const value of candidates) {
      if (!existingNotePaths.has(value) || value === normalizedFromPath || seen.has(value)) {
        continue;
      }
      seen.add(value);
      resolved.push(value);
      break;
    }
  }

  return resolved;
}
