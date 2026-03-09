#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { join } from 'node:path';
import { config } from './config.js';
import { checkModelChanged, getStats, initVecTable, openDb, saveConfigMeta } from './db.js';
import { getContextLength, getEmbeddingDim } from './embedder.js';
import {
  indexFile,
  indexVaultSync,
  populateMissingLinks,
  startBackgroundIndexing,
  startWatcher,
} from './indexer.js';
import { search } from './searcher.js';

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
    config.apiKey || process.env.OPENAI_BASE_URL
      ? config.apiModel
      : 'local:Xenova/all-MiniLM-L6-v2';
  const modelChanged = checkModelChanged(modelName);
  if (modelChanged) {
    console.error('[server] embedding model changed — database cleared, full reindex will run');
  }

  // Phase 2: determine embedding dimension and context length
  const [contextLength, embeddingDim] = await Promise.all([getContextLength(), getEmbeddingDim()]);

  initVecTable(embeddingDim);

  // Phase 3: start MCP server — ready before indexing completes
  const server = new Server(
    { name: 'obsidian-hybrid-search', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'search',
        description:
          "Search the user's personal Obsidian knowledge base — their notes, ideas, and research. " +
          'Use this tool whenever the user asks about something they may have written about, wants to find related notes, or wants to explore their knowledge graph. ' +
          "Use 'query' for text search across all notes (default mode 'hybrid' combines BM25 keyword matching, fuzzy title, and semantic embeddings — best for most questions). " +
          "Use 'path' to find semantically similar notes to a given note path. " +
          "Use 'path' + 'related: true' to traverse the knowledge graph (outgoing links and backlinks). " +
          "Each result includes a 'rank' field (1 = best match). " +
          'Score guide: 0.5+ = strong match, 0.35–0.5 = plausible, below 0.35 = likely noise. ' +
          'Tip: when enriching a specific note with related content, that note itself often appears as rank 1 — skip it.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Text search query (use this for keyword/semantic search)',
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
                'Search mode for text queries (default: hybrid). Ignored when using path.',
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
                'Filter by tag(s). String or array. Prefix with "-" to exclude, e.g. ["-category/cs", "note/basic/primary"]',
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
                'Max snippet length in characters (default: 300). Controls context window for link snippets and fallback text.',
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
          properties: {},
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
        const inputStr = notePath ?? (a.query as string | undefined) ?? '';
        const results = await search(inputStr, {
          mode: a.mode as 'hybrid' | 'semantic' | 'fulltext' | 'title' | undefined,
          scope: a.scope as string | string[] | undefined,
          limit: a.limit as number | undefined,
          threshold: a.threshold as number | undefined,
          tag: a.tag as string | string[] | undefined,
          related: a.related as boolean | undefined,
          depth: a.depth as number | undefined,
          direction: a.direction as 'outgoing' | 'backlinks' | 'both' | undefined,
          snippetLength: a.snippet_length as number | undefined,
          notePath,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify({ results }, null, 2) }],
        };
      }

      if (name === 'reindex') {
        if (a.path) {
          const fullPath = join(config.vaultPath, a.path as string);
          const status = await indexFile(fullPath, contextLength, Boolean(a.force));
          const result =
            status === 'indexed'
              ? { indexed: 1, skipped: 0, errors: [] }
              : status === 'skipped'
                ? { indexed: 0, skipped: 1, errors: [] }
                : {
                    indexed: 0,
                    skipped: 0,
                    errors: [
                      {
                        path: a.path as string,
                        error: typeof status === 'object' ? status.error : 'indexing failed',
                      },
                    ],
                  };
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } else {
          const result = await indexVaultSync(Boolean(a.force));
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        }
      }

      if (name === 'status') {
        const stats = getStats();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  total: stats.total,
                  indexed: stats.indexed,
                  pending: stats.pending,
                  chunks: stats.chunks,
                  links: stats.links,
                  last_indexed: stats.lastIndexed,
                  recent_activity: stats.recentActivity,
                  model: config.apiKey ? config.apiModel : 'Xenova/all-MiniLM-L6-v2 (local)',
                  context_length: contextLength,
                },
                null,
                2,
              ),
            },
          ],
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
