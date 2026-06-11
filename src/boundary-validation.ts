import { z, type ZodError } from 'zod';

const SearchModeSchema = z.enum(['hybrid', 'semantic', 'fulltext', 'title']);
const DirectionSchema = z.enum(['outgoing', 'backlinks', 'both']);
const FiniteNumberSchema = z.number().finite();
const NonNegativeIntegerSchema = FiniteNumberSchema.int().min(0);
const ThresholdSchema = FiniteNumberSchema.min(0).max(1);

export const SearchOptionsBoundarySchema = z.object({
  mode: SearchModeSchema.optional(),
  scope: z.unknown().optional(),
  limit: NonNegativeIntegerSchema.optional(),
  threshold: ThresholdSchema.optional(),
  tag: z.unknown().optional(),
  frontmatter: z.unknown().optional(),
  related: z.boolean().optional(),
  depth: NonNegativeIntegerSchema.optional(),
  direction: DirectionSchema.optional(),
  snippetLength: NonNegativeIntegerSchema.optional(),
  notePath: z.string().optional(),
  rerank: z.boolean().optional(),
  graph: z.boolean().optional(),
  queries: z.array(z.string()).optional(),
  anchors: z.boolean().optional(),
});

export const SearchToolArgumentsSchema = z.object({
  query: z.string().optional(),
  queries: z.array(z.string()).optional(),
  path: z.string().optional(),
  mode: SearchModeSchema.optional(),
  scope: z.unknown().optional(),
  limit: NonNegativeIntegerSchema.optional(),
  threshold: ThresholdSchema.optional(),
  tag: z.unknown().optional(),
  frontmatter: z.unknown().optional(),
  related: z.boolean().optional(),
  depth: NonNegativeIntegerSchema.optional(),
  direction: DirectionSchema.optional(),
  snippet_length: NonNegativeIntegerSchema.optional(),
  rerank: z.boolean().optional(),
  graph: z.boolean().optional(),
  anchors: z.boolean().optional(),
});

export const ReadToolArgumentsSchema = z.object({
  paths: z.unknown(),
  snippet_length: NonNegativeIntegerSchema.optional(),
  related: z.boolean().optional(),
});

export const ReindexToolArgumentsSchema = z.object({
  path: z.string().optional(),
  force: z.boolean().optional(),
});

export const StatusToolArgumentsSchema = z.object({
  include_activity: z.boolean().optional(),
});

export const StdioRequestSchema = z.object({
  id: z.string().optional(),
  query: z.string(),
  options: SearchOptionsBoundarySchema.optional(),
});

export const EmbeddingApiResponseSchema = z.union([
  z
    .object({
      data: z.array(
        z.object({
          embedding: z.array(FiniteNumberSchema),
          index: z.number().int(),
        }),
      ),
    })
    .passthrough(),
  z
    .object({
      error: z
        .object({
          message: z.string().optional(),
        })
        .passthrough(),
    })
    .strict(),
]);

export type SearchOptionsBoundary = z.infer<typeof SearchOptionsBoundarySchema>;
export type SearchToolArguments = z.infer<typeof SearchToolArgumentsSchema>;
export type ReadToolArguments = z.infer<typeof ReadToolArgumentsSchema>;
export type ReindexToolArguments = z.infer<typeof ReindexToolArgumentsSchema>;
export type StatusToolArguments = z.infer<typeof StatusToolArgumentsSchema>;
export type StdioRequest = z.infer<typeof StdioRequestSchema>;
export type EmbeddingApiResponse = z.infer<typeof EmbeddingApiResponseSchema>;
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
