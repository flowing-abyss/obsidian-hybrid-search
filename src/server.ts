#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import {
  checkModelChanged,
  getDb,
  getStats,
  getStoredEmbeddingDim,
  initVecTable,
  openDb,
  saveConfigMeta,
  wipeDatabaseFiles,
} from './db.js';
import { LOCAL_MODEL, getContextLength, getEmbeddingDim, primeEmbeddingDim } from './embedder.js';
import {
  getIndexingStatus,
  indexFile,
  indexVaultSync,
  populateMissingLinks,
  startBackgroundIndexing,
  startWatcher,
} from './indexer.js';
import { readNotes, search } from './searcher.js';

const _dir = dirname(fileURLToPath(import.meta.url));
// Resolve package.json whether running from src/ (tsx) or compiled dist/src/ (node)
const _pkgPath = existsSync(resolve(_dir, '../package.json'))
  ? resolve(_dir, '../package.json')
  : resolve(_dir, '../../package.json');
const { version } = JSON.parse(readFileSync(_pkgPath, 'utf-8')) as { version: string };

async function checkForUpdates(): Promise<void> {
  try {
    const signal = AbortSignal.timeout(3000);
    const res = await fetch('https://registry.npmjs.org/obsidian-hybrid-search/latest', { signal });
    if (!res.ok) return;
    const data = (await res.json()) as { version: string };
    if (data.version !== version) {
      process.stderr.write(
        `[obsidian-hybrid-search] Update available: ${version} → ${data.version}. Run: npm install -g obsidian-hybrid-search\n`,
      );
    }
  } catch {
    // network unavailable — silently ignore
  }
}

/**
 * Parses a value that should be string | string[].
 * Some LLMs serialize arrays as JSON strings (e.g. `'["a","b"]'`); this handles both forms.
 */
// eslint-disable-next-line sonarjs/function-return-type -- union return type is intentional; callers accept string | string[] | undefined
function parseArrayParam(val: unknown): string | string[] | undefined {
  if (val === undefined || val === null) return undefined;
  if (Array.isArray(val)) return val as string[];
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed.startsWith('[')) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- JSON.parse return type is unavoidably any
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed as string[];
      } catch {
        // not a valid JSON array — treat as plain string
      }
    }
    return trimmed || undefined;
  }
  return undefined;
}

async function handleReindex(
  a: Record<string, unknown>,
  contextLength: number,
  modelName: string,
  embeddingDim: number | null,
): Promise<{ indexed: number; skipped: number; errors: unknown[] }> {
  if (a.path) {
    const fullPath = join(config.vaultPath, a.path as string);
    const status = await indexFile(fullPath, contextLength, Boolean(a.force));
    if (status === 'indexed') return { indexed: 1, skipped: 0, errors: [] };
    if (status === 'skipped') return { indexed: 0, skipped: 1, errors: [] };
    return {
      indexed: 0,
      skipped: 0,
      errors: [
        {
          path: a.path as string,
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
    ignorePatternsCsv: config.ignorePatterns.join(','),
  });
  getDb()
    .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('embedding_model', ?)")
    .run(modelName);
  if (embeddingDim !== null) {
    initVecTable(embeddingDim);
  }
}

async function main() {
  // Phase 1: open database
  openDb();

  // Persist config metadata so the DB is self-describing
  saveConfigMeta({
    vaultPath: config.vaultPath,
    apiBaseUrl: config.apiBaseUrl,
    apiModel: config.apiModel,
    ignorePatternsCsv: config.ignorePatterns.join(','),
  });

  // Check if model changed — wipes DB if so, forces full reindex
  const modelName =
    config.apiKey || process.env.OPENAI_BASE_URL ? config.apiModel : `local:${LOCAL_MODEL}`;
  const modelChanged = checkModelChanged(modelName);
  if (modelChanged) {
    console.error('[server] embedding model changed — database cleared, full reindex will run');
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

  // Phase 3: start MCP server — ready before indexing completes
  const server = new Server(
    { name: 'obsidian-hybrid-search', version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'search',
        description:
          "Search the user's personal Obsidian knowledge base — their notes, ideas, and research. " +
          'Use this tool whenever the user asks about something they may have written about, wants to find related notes, or wants to explore their knowledge graph. ' +
          "Use 'query' for text search across all notes (default mode 'hybrid' combines BM25 keyword matching, fuzzy title, and semantic embeddings — best for almost all queries; ranks by how thoroughly notes cover the topic). " +
          "Use 'path' to find semantically similar notes to a given note path. " +
          "Use 'path' + 'related: true' to traverse the knowledge graph (outgoing links and backlinks). " +
          "Each result includes a 'rank' field (1 = best match). " +
          'Score guide: 0.5+ = strong match, 0.35–0.5 = plausible, below 0.35 = likely noise. ' +
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
                'Minimum score threshold 0..1 (default: 0). Use 0.35 to filter out likely noise: results below 0.35 usually matched a single fuzzy-title or keyword signal and are rarely relevant.',
            },
            tag: {
              description:
                'Filter by tag(s). String or array. Prefix with "-" to exclude. ' +
                'Include array = OR logic (note matches any of the tags). ' +
                'Exclude array = AND logic (note must not have any of them). ' +
                'E.g. ["note/basic/primary", "-category/cs"] returns primary notes outside cs.',
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
          },
        },
      },
      {
        name: 'reindex',
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
        name: 'status',
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
        name: 'read',
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
      if (name === 'search') {
        const notePath = a.path as string | undefined;
        const singleQuery = (a.query as string | undefined) ?? '';
        const extraQueriesRaw = a.queries;
        const extraQueries: string[] = Array.isArray(extraQueriesRaw)
          ? (extraQueriesRaw as string[])
          : [];
        // Combine query + queries into a unified list; filter empty strings
        const allQueries = [singleQuery, ...extraQueries].filter(Boolean);
        const inputStr = notePath ?? allQueries[0] ?? '';
        const results = await search(inputStr, {
          mode: a.mode as 'hybrid' | 'semantic' | 'fulltext' | 'title' | undefined,
          scope: parseArrayParam(a.scope),
          limit: a.limit as number | undefined,
          threshold: a.threshold as number | undefined,
          tag: parseArrayParam(a.tag),
          related: a.related as boolean | undefined,
          depth: a.depth as number | undefined,
          direction: a.direction as 'outgoing' | 'backlinks' | 'both' | undefined,
          snippetLength: a.snippet_length as number | undefined,
          rerank: a.rerank as boolean | undefined,
          notePath,
          queries: allQueries.length > 1 ? allQueries : undefined,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify({ results }, null, 2) }],
        };
      }

      if (name === 'reindex') {
        const result = await handleReindex(a, contextLength, modelName, embeddingDim);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      if (name === 'status') {
        const stats = getStats();
        const indexingStatus = getIndexingStatus();
        const output: Record<string, unknown> = {
          total: stats.total,
          indexed: stats.indexed,
          pending: stats.pending + indexingStatus.queued,
          chunks: stats.chunks,
          links: stats.links,
          last_indexed: stats.lastIndexed,
          db_size_mb:
            stats.dbSizeBytes !== null
              ? Math.round((stats.dbSizeBytes / 1024 / 1024) * 10) / 10
              : null,
          model: stats.embeddingModel,
          embedding_dim: stats.embeddingDim,
          context_length: contextLength,
          version,
          ignore_patterns: config.ignorePatterns,
        };
        if (a.include_activity) {
          output.recent_activity = stats.recentActivity;
        }
        const statusText =
          JSON.stringify(output, null, 2) +
          (stats.failedChunks > 0
            ? `\n⚠️  ${stats.failedChunks} chunk(s) have no embeddings (text search still works)`
            : '');
        return {
          content: [
            {
              type: 'text',
              text: statusText,
            },
          ],
        };
      }

      if (name === 'read') {
        const rawPaths = parseArrayParam(a.paths);
        const pathsArray: string[] = Array.isArray(rawPaths)
          ? rawPaths
          : rawPaths
            ? [rawPaths]
            : [];
        const results = readNotes(pathsArray, {
          snippetLength: a.snippet_length as number | undefined,
          related: a.related !== false,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify({ results }, null, 2) }],
        };
      }

      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  checkForUpdates().catch(() => {});

  // Phase 4 & 5: background indexing + watcher (after server is up)
  populateMissingLinks().catch((err) => {
    console.warn('[server] links migration error:', err);
  });
  startBackgroundIndexing(contextLength).catch((err) => {
    console.warn('[server] background indexing error:', err);
  });
  startWatcher(contextLength);
}

main().catch((err) => {
  console.error('[server] fatal error:', err);
  process.exit(1);
});
