import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatValidationError,
  parseStringArrayParam,
  ReadToolArgumentsSchema,
  ReindexToolArgumentsSchema,
  SearchToolArgumentsSchema,
  StatusToolArgumentsSchema,
  type StringArrayParam,
} from './boundary-validation.js';
import { config } from './config.js';
import {
  getDb,
  getStats,
  getStoredEmbeddingDim,
  getStoredModel,
  initVecTable,
  openDb,
  saveConfigMeta,
  wipeDatabaseFiles,
} from './db.js';
import { getContextLength, getEmbeddingDim, primeEmbeddingDim } from './embedder.js';
import {
  getIndexingStatus,
  indexFile,
  indexVaultSync,
  populateMissingLinks,
  startBackgroundIndexing,
  startWatcher,
} from './indexer.js';
import { isAmbiguousNotePathError, readNotes, search } from './searcher.js';

const _dir = dirname(fileURLToPath(import.meta.url));

// Resolve package.json whether running from src/ (tsx) or compiled dist/src/ (node)
const _pkgPath = existsSync(resolve(_dir, '../package.json'))
  ? resolve(_dir, '../package.json')
  : resolve(_dir, '../../package.json');
export const packageVersion = (JSON.parse(readFileSync(_pkgPath, 'utf-8')) as { version: string })
  .version;

export type UpdateStatus =
  | { state: 'checking' }
  | { state: 'up_to_date' }
  | { state: 'update_available'; latestVersion: string }
  | { state: 'offline' };

let updateStatus: UpdateStatus = { state: 'checking' };

export interface McpRuntime {
  version: string;
  contextLength: number;
  modelName: string;
  embeddingDim: number | null;
  getUpdateStatus(): UpdateStatus;
}

type McpTextContent = { type: 'text'; text: string };
type McpToolResult = { content: McpTextContent[]; isError?: true };

export async function checkForUpdates(version = packageVersion): Promise<void> {
  try {
    const signal = AbortSignal.timeout(3000);
    const res = await fetch('https://registry.npmjs.org/obsidian-hybrid-search/latest', { signal });
    if (!res.ok) {
      updateStatus = { state: 'offline' };
      return;
    }
    const data = (await res.json()) as { version: string };
    if (data.version !== version) {
      updateStatus = { state: 'update_available', latestVersion: data.version };
      process.stderr.write(
        `[obsidian-hybrid-search] Update available: ${version} → ${data.version}. Run: npm install -g obsidian-hybrid-search\n`,
      );
    } else {
      updateStatus = { state: 'up_to_date' };
    }
  } catch {
    updateStatus = { state: 'offline' };
  }
}

export async function createMcpRuntime(): Promise<McpRuntime> {
  // Phase 1: open database
  openDb();

  // Persist config metadata so the DB is self-describing
  saveConfigMeta({
    vaultPath: config.vaultPath,
    apiBaseUrl: config.apiBaseUrl,
    apiModel: config.apiModel,
  });

  // Warn if model differs but do NOT wipe — the MCP server is read-oriented.
  // Wiping here would destroy the index whenever env vars are missing at startup.
  // Model-change wipe is intentionally restricted to the reindex command.
  const modelName =
    config.apiKey || process.env.OPENAI_BASE_URL ? config.apiModel : `local:${config.localModel}`;
  const storedModel = getStoredModel();
  if (storedModel && storedModel !== modelName) {
    console.error(
      `[server] embedding model mismatch: DB has "${storedModel}", current env has "${modelName}". Semantic search may be degraded. Run reindex to rebuild vectors.`,
    );
  }

  // Phase 2: determine embedding dimension and context length.
  // Read stored dim from DB first — avoids an API round-trip when the vault was
  // already indexed.  This is the common case and ensures that fulltext / title
  // searches (which never need the embedding API) keep working when offline.
  // Only fall back to getEmbeddingDim() on a fresh install where the DB has no
  // stored value yet.
  const storedDim = getStoredEmbeddingDim();
  const [contextLength, apiDim] = await Promise.all([
    getContextLength(),
    storedDim === null
      ? getEmbeddingDim().catch((err: unknown) => {
          console.error(
            '[server] embedding API unavailable — semantic search and indexing disabled,' +
              ' fulltext/title search still works:',
            err instanceof Error ? err.message : String(err),
          );
          return null;
        })
      : Promise.resolve(null),
  ]);
  const embeddingDim = storedDim ?? apiDim;

  if (embeddingDim !== null) {
    // Seed in-memory dim cache so the zero-vector fallback in the indexer works
    // even if getEmbeddingDim() was never called this session.
    primeEmbeddingDim(embeddingDim);
    initVecTable(embeddingDim);
  } else {
    console.error('[server] embedding dimension unknown — vector table not initialized');
  }

  return {
    version: packageVersion,
    contextLength,
    modelName,
    embeddingDim,
    getUpdateStatus: () => updateStatus,
  };
}

export function startMcpBackgroundServices(runtime: McpRuntime): void {
  checkForUpdates(runtime.version).catch(() => {});

  // Phase 4 & 5: background indexing + watcher (after server is up)
  populateMissingLinks().catch((err) => {
    console.warn('[server] links migration error:', err);
  });
  startBackgroundIndexing(runtime.contextLength).catch((err) => {
    console.warn('[server] background indexing error:', err);
  });
  startWatcher(runtime.contextLength);
}

async function handleReindex(
  a: { path?: string; force?: boolean },
  contextLength: number,
  modelName: string,
  embeddingDim: number | null,
): Promise<{ indexed: number; skipped: number; errors: unknown[] }> {
  if (a.path) {
    const fullPath = join(config.vaultPath, a.path);
    const status = await indexFile(fullPath, contextLength, Boolean(a.force));
    if (status === 'indexed') return { indexed: 1, skipped: 0, errors: [] };
    if (status === 'skipped') return { indexed: 0, skipped: 1, errors: [] };
    return {
      indexed: 0,
      skipped: 0,
      errors: [
        {
          path: a.path,
          error: typeof status === 'object' ? status.error : 'indexing failed',
        },
      ],
    };
  }
  if (a.force) {
    resetDbForForceReindex(modelName, embeddingDim);
  }
  const header = a.force ? 'Recreating database and indexing vault...' : 'Indexing vault...';
  return indexVaultSync(Boolean(a.force), header);
}

function resetDbForForceReindex(modelName: string, embeddingDim: number | null): void {
  wipeDatabaseFiles();
  openDb();
  saveConfigMeta({
    vaultPath: config.vaultPath,
    apiBaseUrl: config.apiBaseUrl,
    apiModel: config.apiModel,
  });
  getDb()
    .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('embedding_model', ?)")
    .run(modelName);
  if (embeddingDim !== null) {
    initVecTable(embeddingDim);
  }
}

function textResult(text: string): McpToolResult {
  return {
    content: [{ type: 'text', text }],
  };
}

function validationErrorResult(text: string): McpToolResult {
  return {
    content: [{ type: 'text', text }],
    isError: true,
  };
}

async function callSearchTool(a: Record<string, unknown>): Promise<McpToolResult> {
  const parsed = SearchToolArgumentsSchema.safeParse(a);
  if (!parsed.success) {
    return validationErrorResult(formatValidationError('search arguments', parsed.error));
  }
  const searchArgs = parsed.data;
  let scope: StringArrayParam;
  let tag: StringArrayParam;
  let frontmatter: StringArrayParam;
  try {
    scope = parseStringArrayParam('scope', searchArgs.scope);
    tag = parseStringArrayParam('tag', searchArgs.tag);
    frontmatter = parseStringArrayParam('frontmatter', searchArgs.frontmatter);
  } catch (err) {
    return validationErrorResult(
      `Invalid search arguments: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const notePath = searchArgs.path;
  const singleQuery = searchArgs.query ?? '';
  const extraQueries = searchArgs.queries ?? [];
  // Combine query + queries into a unified list; filter empty strings
  const allQueries = [singleQuery, ...extraQueries].filter(Boolean);
  const inputStr = notePath ?? allQueries[0] ?? '';
  let results;
  try {
    results = await search(inputStr, {
      mode: searchArgs.mode,
      scope,
      limit: searchArgs.limit,
      threshold: searchArgs.threshold,
      tag,
      frontmatter,
      related: searchArgs.related,
      depth: searchArgs.depth,
      direction: searchArgs.direction,
      snippetLength: searchArgs.snippet_length,
      rerank: searchArgs.rerank,
      anchors: searchArgs.anchors,
      notePath,
      queries: allQueries.length > 1 ? allQueries : undefined,
    });
  } catch (err) {
    if (isAmbiguousNotePathError(err)) {
      return textResult(JSON.stringify({ type: 'ambiguous', candidates: err.candidates }, null, 2));
    }
    throw err;
  }
  return textResult(JSON.stringify({ results }, null, 2));
}

async function callReindexTool(
  a: Record<string, unknown>,
  runtime: McpRuntime,
): Promise<McpToolResult> {
  const parsed = ReindexToolArgumentsSchema.safeParse(a);
  if (!parsed.success) {
    return validationErrorResult(formatValidationError('reindex arguments', parsed.error));
  }
  const result = await handleReindex(
    parsed.data,
    runtime.contextLength,
    runtime.modelName,
    runtime.embeddingDim,
  );
  return textResult(JSON.stringify(result, null, 2));
}

function callStatusTool(a: Record<string, unknown>, runtime: McpRuntime): McpToolResult {
  const parsed = StatusToolArgumentsSchema.safeParse(a);
  if (!parsed.success) {
    return validationErrorResult(formatValidationError('status arguments', parsed.error));
  }
  const statusArgs = parsed.data;
  const stats = getStats();
  const indexingStatus = getIndexingStatus();
  const currentUpdateStatus = runtime.getUpdateStatus();
  const output: Record<string, unknown> = {
    total: stats.total,
    indexed: stats.indexed,
    pending: indexingStatus.queued,
    chunks: stats.chunks,
    links: stats.links,
    last_indexed: stats.lastIndexed,
    db_size_mb:
      stats.dbSizeBytes !== null ? Math.round((stats.dbSizeBytes / 1024 / 1024) * 10) / 10 : null,
    api_base_url: config.apiBaseUrl,
    model: stats.embeddingModel,
    embedding_dim: stats.embeddingDim,
    context_length: runtime.contextLength,
    version: runtime.version,
    ...(currentUpdateStatus.state === 'update_available'
      ? {
          latest_version: currentUpdateStatus.latestVersion,
          update_command: 'npm install -g obsidian-hybrid-search',
        }
      : currentUpdateStatus.state === 'offline'
        ? { version_check: 'offline' }
        : {}),
    ignore_patterns: config.ignorePatterns,
  };
  if (statusArgs.include_activity) {
    output.recent_activity = stats.recentActivity;
  }
  const statusText =
    JSON.stringify(output, null, 2) +
    (stats.failedChunks > 0
      ? `\n⚠️  ${stats.failedChunks} chunk(s) have no embeddings (text search still works)`
      : '');
  return textResult(statusText);
}

function callReadTool(a: Record<string, unknown>): McpToolResult {
  const parsed = ReadToolArgumentsSchema.safeParse(a);
  if (!parsed.success) {
    return validationErrorResult(formatValidationError('read arguments', parsed.error));
  }
  const readArgs = parsed.data;
  let rawPaths: StringArrayParam;
  try {
    rawPaths = parseStringArrayParam('paths', readArgs.paths);
  } catch (err) {
    return validationErrorResult(
      `Invalid read arguments: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const pathsArray: string[] = Array.isArray(rawPaths) ? rawPaths : rawPaths ? [rawPaths] : [];
  const results = readNotes(pathsArray, {
    snippetLength: readArgs.snippet_length,
    related: readArgs.related !== false,
  });
  return textResult(JSON.stringify({ results }, null, 2));
}

export function createMcpServer(runtime: McpRuntime): Server {
  // Phase 3: start MCP server — ready before indexing completes
  const server = new Server(
    { name: 'obsidian-hybrid-search', version: runtime.version },
    { capabilities: { tools: {} } },
  );
  const toolName = (name: string): string => `${config.obsidianPrefix}${name}`;
  const isTool = (actual: string, expected: string): boolean =>
    actual === toolName(expected) || actual === expected;

  // eslint-disable-next-line @typescript-eslint/require-await
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: toolName('search'),
        description:
          "Search the user's personal Obsidian knowledge base — their notes, ideas, and research. " +
          'Use this tool whenever the user asks about something they may have written about, wants to find related notes, or wants to explore their knowledge graph. ' +
          "Use 'query' for text search across all notes (default mode 'hybrid' combines BM25 keyword matching, fuzzy title, and semantic embeddings — best for almost all queries; ranks by how thoroughly notes cover the topic). " +
          "Use 'path' to find semantically similar notes to a given note path. " +
          "Use 'path' + 'related: true' to traverse the knowledge graph (outgoing links and backlinks). " +
          "Each result includes a 'rank' field (1 = best match). " +
          'Score guide: 0.8–1.0 = highly relevant, 0.5–0.8 = moderately relevant, 0.2–0.5 = somewhat relevant, below 0.2 = low relevance. ' +
          'Tip: when enriching a specific note with related content, that note itself often appears as rank 1 — skip it. ' +
          'Returns: path, title, tags[], snippet, score (0-1), matchedBy[], links[], backlinks[], scores{semantic?, bm25?, fuzzy_title?}. null means no match for that type.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description:
                'Text search query. For multi-query fan-out (better recall), use queries[] instead or alongside this field.',
            },
            queries: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Multi-query fan-out: pass 2–4 reformulations of the same question to improve recall. ' +
                'The server runs all queries in parallel and merges results via RRF fusion — a note that ranks highly in any one query floats to the top. ' +
                'Especially useful when the note may use different vocabulary (e.g. ["task management", "GTD productivity", "organizing todos"]). ' +
                'If query is also provided, it is prepended to this list. ' +
                'Reranking (rerank: true) is applied once after all results are merged, not per-query.',
            },
            path: {
              type: 'string',
              description:
                'Note path for semantic similarity search, e.g. "notes/pkm/zettelkasten.md". Always uses semantic embedding (title + content). Combine with related: true for graph traversal.',
            },
            mode: {
              type: 'string',
              enum: ['hybrid', 'semantic', 'fulltext', 'title'],
              description:
                'Search mode for text queries (default: hybrid). Ignored when using path. ' +
                'hybrid: combines BM25 + semantic + fuzzy title; ranks by content depth — how thoroughly a note discusses the topic. Use for almost all queries. A note whose alias matches the query is NOT automatically ranked first; content coverage determines rank. ' +
                'title: fuzzy title and exact alias match — use only when navigating to a specific named note (e.g. the definition page for a concept), not for topic exploration. ' +
                'semantic: pure vector similarity — use when exact wording is unpredictable. ' +
                'fulltext: BM25 keyword matching only — use for exact term lookup.',
            },
            scope: {
              description:
                'Limit search to subfolder(s). String or array. Prefix with "-" to exclude, e.g. ["-notes/dev/"]',
              oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
            },
            limit: {
              type: 'number',
              description:
                'Maximum results to return (default: 10). Keep at 10 or below for best signal-to-noise; results past position 10 frequently score below 0.35.',
            },
            threshold: {
              type: 'number',
              description:
                'Minimum score threshold 0..1 (default: 0). Use 0.2 to filter out low relevance results.',
            },
            tag: {
              description:
                'Filter by tag(s). String or array. Prefix with "-" to exclude. ' +
                'Include array = OR logic (note matches any of the tags). ' +
                'Exclude array = AND logic (note must not have any of them). ' +
                'E.g. ["note/basic/primary", "-category/cs"] returns primary notes outside cs.',
              oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
            },
            frontmatter: {
              description:
                'Filter by frontmatter field(s). String or array. Format: "field:value". Prefix with "-" to exclude. ' +
                'Include array = AND logic (note must have all specified fields with matching values). ' +
                'Exclude array = AND logic (note must not have any of the excluded field values). ' +
                'E.g. ["status:todo", "priority:high"] returns notes with status=todo AND priority=high. ' +
                'Omit query to list all notes matching frontmatter filters (sorted by title).',
              oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
            },
            related: {
              type: 'boolean',
              description:
                'Graph traversal mode: find notes linked to/from the given path. Results include depth field (negative = backlink, positive = outgoing, 0 = source).',
            },
            depth: {
              type: 'number',
              description: 'Max traversal depth for related mode (default: 1)',
            },
            direction: {
              type: 'string',
              enum: ['outgoing', 'backlinks', 'both'],
              description:
                'Direction for related mode (default: both). "outgoing" = notes this note links to; "backlinks" = notes that link to this note.',
            },
            snippet_length: {
              type: 'number',
              description:
                'Max snippet length in characters (default: 300). ' +
                'Increase to 600-1000 for aggregator/index notes where more surrounding context is needed.',
            },
            rerank: {
              type: 'boolean',
              description:
                'Enable cross-encoder re-ranking for higher precision. Downloads ~32MB model on first use (cached). Recommended when result order matters. Only applies to hybrid mode (default). Default: false.',
            },
            anchors: {
              type: 'boolean',
              description:
                'When true, includes previewAnchors in each result for precise UI navigation. ' +
                'Each anchor has headingPath, matchText, charStart, charEnd. ' +
                'Not needed for most MCP use cases — the snippet field is sufficient. ' +
                'Use when building a UI that renders the note and needs to scroll to the matched region. ' +
                'Default: false.',
            },
          },
        },
      },
      {
        name: toolName('reindex'),
        description:
          'Reindex a specific file or the entire vault (incremental — only changed files)',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Relative path to a specific file. Omit to reindex the whole vault.',
            },
            force: {
              type: 'boolean',
              description: 'Force reindex even if files are unchanged',
            },
          },
        },
      },
      {
        name: toolName('status'),
        description: 'Get indexing status and configuration',
        inputSchema: {
          type: 'object',
          properties: {
            include_activity: {
              type: 'boolean',
              description: 'Include recent activity log in the response',
            },
          },
        },
      },
      {
        name: toolName('read'),
        description:
          'Fetch one or more Obsidian notes by vault-relative path and return their full content with metadata. ' +
          'Use after search or related traversal to read the actual content of notes you found. ' +
          'Returns title, aliases, tags, content (full text), links (outgoing wikilinks), and backlinks. ' +
          'On path miss: returns found:false with top-3 fuzzy title suggestions — does not throw. ' +
          'Accepts a single path string or an array of paths for batch reading. ' +
          'Use snippet_length to cap content size when reading many notes at once. ' +
          'related:false skips link/backlink lookup (faster when you only need content).',
        inputSchema: {
          type: 'object',
          required: ['paths'],
          properties: {
            paths: {
              description:
                'Vault-relative path(s) to read, e.g. "notes/foo.md" or ["notes/foo.md", "notes/bar.md"]. ' +
                'Accepts a single string or an array.',
              oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
            },
            snippet_length: {
              type: 'number',
              description:
                'Max characters of content returned per note (default: full content). ' +
                'Use to limit context window usage when reading multiple notes, e.g. 2000. ' +
                'Content is hard-truncated at this character count with no ellipsis.',
            },
            related: {
              type: 'boolean',
              description:
                'Include links[] and backlinks[] in the response (default: true). ' +
                'Set to false for faster reads when you only need the content.',
            },
          },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const a: Record<string, unknown> = args ?? {};

    try {
      if (isTool(name, 'search')) {
        return callSearchTool(a);
      }

      if (isTool(name, 'reindex')) {
        return callReindexTool(a, runtime);
      }

      if (isTool(name, 'status')) {
        return callStatusTool(a, runtime);
      }

      if (isTool(name, 'read')) {
        return callReadTool(a);
      }

      return validationErrorResult(`Unknown tool: ${name}`);
    } catch (err) {
      return validationErrorResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  return server;
}
