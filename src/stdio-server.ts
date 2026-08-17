import {
  formatValidationError,
  parseStringArrayParam,
  StdioRequestSchema,
  StdioStatusRequestSchema,
  type SearchOptionsBoundary,
} from './boundary-validation.js';
import type { SearchOptions, SearchResult } from './searcher.js';

export type SearchFunction = (query: string, options?: SearchOptions) => Promise<SearchResult[]>;
export type StatusFunction = () => Promise<Record<string, unknown>> | Record<string, unknown>;

export interface StdioResponse {
  id: string;
  results?: SearchResult[];
  status?: Record<string, unknown>;
  error?: string;
}

/**
 * Process a single newline-delimited JSON request for the stdio IPC server.
 * Exported for unit testing — called by `ohs serve --stdio` in a loop.
 *
 * Protocol:
 *   Request:  {"id":"1","query":"zettelkasten","options":{...}}
 *   Response: {"id":"1","results":[...]}
 *   Request:  {"id":"2","action":"status"}
 *   Response: {"id":"2","status":{...}}
 *   Error:    {"id":"1","error":"message"}
 */
export async function handleStdioLine(
  line: string,
  searchFn: SearchFunction,
  writeLine: (s: string) => void,
  statusFn?: StatusFunction,
): Promise<void> {
  const trimmed = line.trim();
  if (!trimmed) return;

  let id = 'unknown';
  try {
    const raw: unknown = JSON.parse(trimmed);
    if (isRecord(raw) && typeof raw.id === 'string') {
      id = raw.id;
    }

    // Status requests are matched first and separately so that search requests keep
    // reporting field-level validation errors rather than an opaque union error.
    if (StdioStatusRequestSchema.safeParse(raw).success) {
      if (!statusFn) {
        writeLine(JSON.stringify({ id, error: 'status is not available on this server' }));
        return;
      }
      writeLine(JSON.stringify({ id, status: await statusFn() }));
      return;
    }

    const parsed = StdioRequestSchema.safeParse(raw);
    if (!parsed.success) {
      writeLine(
        JSON.stringify({ id, error: formatValidationError('stdio request', parsed.error) }),
      );
      return;
    }

    const req = parsed.data;
    const options = normalizeSearchOptions(req.options);
    const results = await searchFn(req.query, options);
    writeLine(JSON.stringify({ id, results }));
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    writeLine(JSON.stringify({ id, error }));
  }
}

function normalizeSearchOptions(rawOptions: SearchOptionsBoundary | undefined): SearchOptions {
  if (rawOptions === undefined) {
    return {};
  }

  const options: SearchOptions = {};
  if (rawOptions.mode !== undefined) options.mode = rawOptions.mode;
  if (rawOptions.limit !== undefined) options.limit = rawOptions.limit;
  if (rawOptions.threshold !== undefined) options.threshold = rawOptions.threshold;
  if (rawOptions.related !== undefined) options.related = rawOptions.related;
  if (rawOptions.depth !== undefined) options.depth = rawOptions.depth;
  if (rawOptions.direction !== undefined) options.direction = rawOptions.direction;
  if (rawOptions.linkType !== undefined) options.linkType = rawOptions.linkType;
  if (rawOptions.snippetLength !== undefined) options.snippetLength = rawOptions.snippetLength;
  if (rawOptions.notePath !== undefined) options.notePath = rawOptions.notePath;
  if (rawOptions.rerank !== undefined) options.rerank = rawOptions.rerank;
  if (rawOptions.queries !== undefined) options.queries = rawOptions.queries;
  if (rawOptions.anchors !== undefined) options.anchors = rawOptions.anchors;

  const scope = parseStringArrayParam('scope', rawOptions.scope);
  if (scope !== undefined) options.scope = scope;
  const tag = parseStringArrayParam('tag', rawOptions.tag);
  if (tag !== undefined) options.tag = tag;
  const frontmatter = parseStringArrayParam('frontmatter', rawOptions.frontmatter);
  if (frontmatter !== undefined) options.frontmatter = frontmatter;

  return options;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
