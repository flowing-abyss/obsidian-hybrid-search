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
  wipeDatabaseSidecars,
} from './db.js';
import {
  activeModelName,
  getContextLength,
  getEmbeddingDim,
  primeEmbeddingDim,
  useRemoteEmbeddings,
} from './embedder.js';
import {
  getIndexingStatus,
  indexFileWithRecovery,
  indexVaultSync,
  populateMissingLinks,
  populateMissingMarkdownReferences,
  startBackgroundIndexing,
  startWatcher,
  withIndexingDbLock,
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
  const modelName = activeModelName();
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

  await withIndexingDbLock(async () => {
    await populateMissingLinks();
    await populateMissingMarkdownReferences();
  });

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
    const status = await withIndexingDbLock(() =>
      indexFileWithRecovery(fullPath, contextLength, Boolean(a.force), () =>
        resetDbAfterSidecarRecovery(modelName, embeddingDim),
      ),
    );
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

  return withIndexingDbLock(async () => {
    if (a.force) {
      resetDbForForceReindex(modelName, embeddingDim);
    }
    const header = a.force ? 'Recreating database and indexing vault...' : 'Indexing vault...';
    return indexVaultSync(Boolean(a.force), header, {
      recoverDatabase: () => resetDbAfterSidecarRecovery(modelName, embeddingDim),
    });
  });
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

function resetDbAfterSidecarRecovery(modelName: string, embeddingDim: number | null): void {
  wipeDatabaseSidecars();
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
      linkType: searchArgs.link_type,
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
    notes_without_chunks: stats.withoutChunks,
    pending: indexingStatus.queued,
    chunks: stats.chunks,
    failed_chunks: stats.failedChunks,
    links: stats.links,
    last_indexed: stats.lastIndexed,
    db_size_mb:
      stats.dbSizeBytes !== null ? Math.round((stats.dbSizeBytes / 1024 / 1024) * 10) / 10 : null,
    api_base_url: useRemoteEmbeddings() ? config.apiBaseUrl : null,
    model: stats.embeddingModel,
    active_model: activeModelName(),
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
    respect_gitignore: config.respectGitignore,
    include_patterns: config.includePatterns,
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
          "Use 'queries' for 2-4 reformulations when recall matters. " +
          "Use 'path' to find semantically similar notes to a given note path, excluding the source note and its outgoing links. " +
          "Use 'path' + 'related: true' to traverse the knowledge graph (outgoing links and backlinks); use link_type to choose wiki, markdown, or all note links. " +
          "Each result includes a 'rank' field (1 = best match). " +
          'Score guide for ranked text/path results: 0.8–1.0 = highly relevant, 0.5–0.8 = moderately relevant, 0.2–0.5 = somewhat relevant, below 0.2 = low relevance. ' +
          'In related mode, the source note is included at depth 0; skip it when you need only neighbors. ' +
          'Returns: path, title, tags[], snippet, score (0-1), matchedBy[], links[], backlinks[], markdownLinks[], markdownBacklinks[], urls[], scores{semantic,bm25,fuzzy_title,hybrid}. links/backlinks are wikilinks; markdownLinks/markdownBacklinks are resolved Markdown file links; urls are external HTTP(S) metadata. Score fields are numbers or null.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description:
                'Text search query. For multi-query fan-out and better recall, use queries[] instead or alongside this field.',
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
                "Vault-relative path to a note. Returns notes semantically similar to that note, ranked by embedding similarity, excluding the note itself and any note it already links to. Combines with tag/scope/frontmatter filters: the filter is applied to the candidate pool, so a narrow filter still returns the closest matches within it. Use this to find where a note belongs — related aggregators, overlapping topics. Do NOT use it for text search; it ignores the `query` argument entirely — use `query` without `path` for that. Do NOT use it to list a note's existing links — use `related` instead.",
            },
            mode: {
              type: 'string',
              enum: ['hybrid', 'semantic', 'fulltext', 'title'],
              description:
                'Text search mode; ignored when path is provided. ' +
                'hybrid (default): BM25 + semantic + fuzzy title via RRF; use for most topic/concept searches. It ranks by content coverage, so exact title/alias matches are not guaranteed rank 1. ' +
                'title: fuzzy title + exact alias matching; use only to navigate to a specific named note. ' +
                'fulltext: BM25 keyword/prefix matching; use for exact terms or distinctive words. semantic: pure vector similarity; use when wording is uncertain.',
            },
            scope: {
              description:
                'Path-prefix filter for folders. Use when the user explicitly limits search to an area of the vault, e.g. "projects/". ' +
                'This does not change ranking semantics or infer topic scope; it only includes/excludes paths. String or array; prefix with "-" to exclude.',
              oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
            },
            limit: {
              type: 'number',
              description:
                'How many text/path/filter-only results to return; related traversal uses depth instead. 0 means no limit. Default 10. ' +
                'tag/scope/frontmatter filters are applied inside the query, so limit caps the filtered results, not a pre-filter pool: a narrow filter still returns up to limit matches instead of whatever survived the global top-limit. ' +
                'Do NOT raise limit to compensate for a narrow filter — raise it only when the user genuinely wants more results. ' +
                'Keep at 10 or below for best signal-to-noise unless the user asks for broad enumeration; results past position 10 frequently score below 0.35.',
            },
            threshold: {
              type: 'number',
              description:
                'Minimum score 0..1 after text/path ranking. Use ~0.2 to hide weak matches when precision matters. ' +
                'Ignored by related and filter-only searches; keep 0 for exploration or when recall matters because high thresholds can drop useful results.',
            },
            tag: {
              description:
                'Tag filter. Use when the user specifies tags/categories, not as a substitute for semantic topic search. String or array; prefix with "-" to exclude. ' +
                'Multiple include tags are ANDed; excluded tags remove notes with any excluded tag. ' +
                'E.g. ["note/basic/primary", "-category/cs"] returns primary notes outside cs.',
              oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
            },
            frontmatter: {
              description:
                'Frontmatter field filter in "field:value" format. Use for structured metadata such as status, priority, project, milestone, or type. ' +
                'Omit query to list matching notes sorted by title. String or array; prefix with "-" to exclude; include filters are ANDed. ' +
                'E.g. ["status:todo", "priority:high"] returns notes with status=todo AND priority=high.',
              oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
            },
            related: {
              type: 'boolean',
              description:
                'Graph traversal from a note path instead of text search. Use with path when the user asks for linked notes, backlinks, neighborhoods, or context around a specific note. ' +
                'By default follows explicit wikilinks only; set link_type to markdown or all when the vault uses standard Markdown file links. It does not do semantic similarity unless path is used without related. Results include depth: negative = backlink, positive = outgoing, 0 = source.',
            },
            depth: {
              type: 'number',
              description:
                'Maximum graph traversal depth for related mode; default 1. Use 1 for immediate links/backlinks, 2+ only when the user asks for a broader neighborhood. Larger depths can return noisy or loosely related notes.',
            },
            direction: {
              type: 'string',
              enum: ['outgoing', 'backlinks', 'both'],
              description:
                'Traversal direction for related mode; default both. outgoing returns notes the source links to, backlinks returns notes that link to the source, both returns both. ' +
                'Use a specific direction only when the user asks for it or the workflow implies it.',
            },
            link_type: {
              type: 'string',
              enum: ['wiki', 'markdown', 'all'],
              description:
                'Graph source for related mode; default wiki. wiki follows Obsidian [[wikilinks]], markdown follows resolved standard Markdown file links like [text](note.md), all follows the union with wiki edges first. ' +
                'Use markdown for OKF-style or portable Markdown vaults. Do not use this for external URLs; urls[] are returned as metadata and are never traversed.',
            },
            snippet_length: {
              type: 'number',
              description:
                'Maximum snippet length in characters; default 300. Increase when notes need more surrounding context. ' +
                'Use 600-1000 for aggregator/index notes. This affects returned context only, not retrieval, ranking, or matching.',
            },
            rerank: {
              type: 'boolean',
              description:
                'Enable cross-encoder reranking after hybrid retrieval for better ordering when result precision matters. Adds latency and downloads/caches a ~570MB model on first use. ' +
                'Only applies to hybrid mode; do not use for exact title, alias, or keyword lookups. Default: false.',
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
          'Reindex a specific file or the vault. Use only when the index is stale/missing or the user asks. Incremental by default; force:true with no path recreates the database.',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Relative path to a specific file. Omit to reindex the whole vault.',
            },
            force: {
              type: 'boolean',
              description:
                'Force reindex even if files are unchanged. With no path, recreates the database before indexing.',
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
          'Use directly when the user provides vault-relative path(s), or after search/related traversal to read notes you found. ' +
          'Returns title, aliases, tags, content (full text), links/backlinks (wikilinks), markdownLinks/markdownBacklinks (resolved Markdown file links), and urls (external HTTP(S) metadata). ' +
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
