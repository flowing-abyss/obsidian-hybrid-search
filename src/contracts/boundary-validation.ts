import { z, type ZodError } from 'zod';

// Bound semantic fan-out and SQL parameter growth independently of transport
// payload sizes: a compact JSON request can otherwise trigger unbounded work.
export const SEARCH_REQUEST_LIMITS = {
  maxQueries: 16,
  maxQueryLength: 16_384,
  maxFilters: 128,
  maxFilterLength: 4096,
  maxResults: 10_000,
  maxSnippetLength: 100_000,
  maxDepth: 64,
  maxReadPaths: 128,
  maxGraphNodes: 10_000,
  maxGraphEdges: 100_000,
} as const;

const SearchModeSchema = z.enum(['hybrid', 'semantic', 'fulltext', 'title']);
const DirectionSchema = z.enum(['outgoing', 'backlinks', 'both']);
const LinkTypeSchema = z.enum(['wiki', 'markdown', 'all']);
const FiniteNumberSchema = z.number().finite();
const NonNegativeIntegerSchema = FiniteNumberSchema.int().min(0);
const ThresholdSchema = FiniteNumberSchema.min(0).max(1);
const QuerySchema = z.string().max(SEARCH_REQUEST_LIMITS.maxQueryLength);
const QueriesSchema = z.array(QuerySchema).max(SEARCH_REQUEST_LIMITS.maxQueries);
const PathSchema = z.string().max(SEARCH_REQUEST_LIMITS.maxFilterLength);
const LimitSchema = NonNegativeIntegerSchema.max(SEARCH_REQUEST_LIMITS.maxResults);
const DepthSchema = NonNegativeIntegerSchema.max(SEARCH_REQUEST_LIMITS.maxDepth);
const SnippetLengthSchema = NonNegativeIntegerSchema.max(SEARCH_REQUEST_LIMITS.maxSnippetLength);

export const SearchOptionsBoundarySchema = z.object({
  mode: SearchModeSchema.optional(),
  scope: z.unknown().optional(),
  limit: LimitSchema.optional(),
  threshold: ThresholdSchema.optional(),
  tag: z.unknown().optional(),
  frontmatter: z.unknown().optional(),
  related: z.boolean().optional(),
  depth: DepthSchema.optional(),
  direction: DirectionSchema.optional(),
  linkType: LinkTypeSchema.optional(),
  snippetLength: SnippetLengthSchema.optional(),
  notePath: PathSchema.optional(),
  rerank: z.boolean().optional(),
  queries: QueriesSchema.optional(),
  anchors: z.boolean().optional(),
});

export const SearchToolArgumentsSchema = z
  .object({
    query: QuerySchema.optional(),
    queries: QueriesSchema.optional(),
    path: PathSchema.optional(),
    mode: SearchModeSchema.optional(),
    scope: z.unknown().optional(),
    limit: LimitSchema.optional(),
    threshold: ThresholdSchema.optional(),
    tag: z.unknown().optional(),
    frontmatter: z.unknown().optional(),
    related: z.boolean().optional(),
    depth: DepthSchema.optional(),
    direction: DirectionSchema.optional(),
    link_type: LinkTypeSchema.optional(),
    snippet_length: SnippetLengthSchema.optional(),
    rerank: z.boolean().optional(),
    anchors: z.boolean().optional(),
  })
  .refine(
    (args) =>
      (args.queries?.length ?? 0) + (args.query ? 1 : 0) <= SEARCH_REQUEST_LIMITS.maxQueries,
    {
      path: ['queries'],
      message: `query and queries must contain at most ${SEARCH_REQUEST_LIMITS.maxQueries} queries combined`,
    },
  );

export const ReadToolArgumentsSchema = z.object({
  paths: z.unknown(),
  snippet_length: SnippetLengthSchema.optional(),
  related: z.boolean().optional(),
});

export const ReindexToolArgumentsSchema = z.object({
  path: PathSchema.optional(),
  force: z.boolean().optional(),
});

export const StatusToolArgumentsSchema = z.object({
  include_activity: z.boolean().optional(),
});

export const StdioStatusRequestSchema = z.object({
  id: z.string().optional(),
  action: z.literal('status'),
});

export const StdioRequestSchema = z.object({
  id: z.string().optional(),
  query: QuerySchema,
  options: SearchOptionsBoundarySchema.optional(),
});

export const EmbeddingApiResponseSchema = z.union([
  z
    .object({
      data: z.array(
        z.object({
          embedding: z.array(FiniteNumberSchema),
          index: z.number().int().optional(),
        }),
      ),
    })
    .passthrough(),
  z
    .object({
      error: z
        .object({
          code: z.union([z.string(), z.number()]).optional(),
          message: z.string().optional(),
          type: z.string().optional(),
          metadata: z
            .object({
              error_type: z.string().optional(),
            })
            .passthrough()
            .optional(),
        })
        .passthrough(),
    })
    .strict(),
]);

export const OllamaEmbeddingResponseSchema = z
  .object({
    embeddings: z.array(z.array(FiniteNumberSchema)),
  })
  .passthrough();

export type SearchOptionsBoundary = z.infer<typeof SearchOptionsBoundarySchema>;
export type StringArrayParam = string | string[] | undefined;

export function formatValidationError(context: string, error: ZodError): string {
  const details = error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : 'value';
      return `${path} ${issue.message}`;
    })
    .join('; ');
  return `Invalid ${context}: ${details}`;
}

export function parseStringArrayParam(name: string, value: unknown): StringArrayParam {
  let result: StringArrayParam;
  if (value === undefined || value === null) {
    result = undefined;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    result = trimmed || undefined;
    if (trimmed.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          assertStringArray(name, parsed);
          result = parsed;
        }
      } catch (error) {
        if (error instanceof Error && error.message === stringArrayErrorMessage(name)) {
          throw error;
        }
      }
    }
  } else if (Array.isArray(value)) {
    assertStringArray(name, value);
    result = value;
  } else {
    throw new Error(stringArrayErrorMessage(name));
  }

  const values = result === undefined ? [] : Array.isArray(result) ? result : [result];
  const maxItems =
    name === 'paths' ? SEARCH_REQUEST_LIMITS.maxReadPaths : SEARCH_REQUEST_LIMITS.maxFilters;
  if (values.length > maxItems) {
    throw new Error(`Invalid ${name}: expected at most ${maxItems} values`);
  }
  if (values.some((item) => item.length > SEARCH_REQUEST_LIMITS.maxFilterLength)) {
    throw new Error(
      `Invalid ${name}: each value must contain at most ${SEARCH_REQUEST_LIMITS.maxFilterLength} characters`,
    );
  }
  return result;
}

export function parseCliIntegerOption(
  name: string,
  raw: string,
  options: { min?: number; max?: number } = {},
): number {
  const value = raw.trim();
  if (!/^[+-]?\d+$/.test(value)) {
    throw new Error(`Invalid ${name}: expected integer`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid ${name}: expected safe integer`);
  }

  enforceRange(name, parsed, options);
  return parsed;
}

export function parseCliNumberOption(
  name: string,
  raw: string,
  options: { min?: number; max?: number } = {},
): number {
  const value = raw.trim();
  if (value === '') {
    throw new Error(`Invalid ${name}: expected finite number`);
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${name}: expected finite number`);
  }

  enforceRange(name, parsed, options);
  return parsed;
}

function assertStringArray(name: string, value: unknown[]): asserts value is string[] {
  if (!value.every((item) => typeof item === 'string')) {
    throw new Error(stringArrayErrorMessage(name));
  }
}

function stringArrayErrorMessage(name: string): string {
  return `Invalid ${name}: expected string or array of strings`;
}

function enforceRange(name: string, value: number, options: { min?: number; max?: number }): void {
  if (options.min !== undefined && value < options.min) {
    throw new Error(`Invalid ${name}: expected >= ${options.min}`);
  }
  if (options.max !== undefined && value > options.max) {
    throw new Error(`Invalid ${name}: expected <= ${options.max}`);
  }
}
