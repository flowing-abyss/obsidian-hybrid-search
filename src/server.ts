#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { config } from './config.js'
import { openDb, initVecTable, checkModelChanged, getStats, saveConfigMeta } from './db.js'
import { getContextLength, getEmbeddingDim } from './embedder.js'
import { startBackgroundIndexing, startWatcher, indexFile, indexVaultSync, populateMissingLinks } from './indexer.js'
import { search } from './searcher.js'

async function main() {
  // Phase 1: open database
  openDb()

  // Persist config metadata so the DB is self-describing
  saveConfigMeta({
    vaultPath: config.vaultPath,
    apiBaseUrl: config.apiBaseUrl,
    apiModel: config.apiModel,
    ignorePatternsCsv: config.ignorePatterns.join(','),
  })

  // Check if model changed — wipes DB if so, forces full reindex
  const modelName = config.apiKey ? config.apiModel : 'local:Xenova/all-MiniLM-L6-v2'
  const modelChanged = checkModelChanged(modelName)
  if (modelChanged) {
    console.error('[server] embedding model changed — database cleared, full reindex will run')
  }

  // Phase 2: determine embedding dimension and context length
  const [contextLength, embeddingDim] = await Promise.all([
    getContextLength(),
    getEmbeddingDim(),
  ])

  initVecTable(embeddingDim)

  // Phase 3: start MCP server — ready before indexing completes
  const server = new Server(
    { name: 'obsidian-hybrid-search', version: '0.1.0' },
    { capabilities: { tools: {} } }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'search',
        description:
          'Search the Obsidian vault. Supports hybrid, semantic, fulltext, and title modes. ' +
          'Pass a path (contains / or ends with .md) to find similar notes.',
        inputSchema: {
          type: 'object',
          properties: {
            input: {
              type: 'string',
              description: 'Search query or note path for similarity search',
            },
            mode: {
              type: 'string',
              enum: ['hybrid', 'semantic', 'fulltext', 'title'],
              description: 'Search mode (default: hybrid)',
            },
            scope: {
              type: 'string',
              description: 'Limit search to a subfolder, e.g. "notes/pkm/"',
            },
            limit: {
              type: 'number',
              description: 'Maximum results to return (default: 10)',
            },
            threshold: {
              type: 'number',
              description: 'Minimum score threshold 0..1 (default: 0)',
            },
          },
          required: ['input'],
        },
      },
      {
        name: 'reindex',
        description: 'Reindex a specific file or the entire vault (incremental — only changed files)',
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
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params
    const a = (args ?? {}) as Record<string, unknown>

    try {
      if (name === 'search') {
        const results = await search(String(a.input), {
          mode: a.mode as any,
          scope: a.scope as string | undefined,
          limit: a.limit as number | undefined,
          threshold: a.threshold as number | undefined,
        })
        return {
          content: [{ type: 'text', text: JSON.stringify({ results }, null, 2) }],
        }
      }

      if (name === 'reindex') {
        if (a.path) {
          const { join } = await import('node:path')
          const fullPath = join(config.vaultPath, String(a.path))
          const status = await indexFile(fullPath, contextLength, Boolean(a.force))
          const result =
            status === 'indexed'
              ? { indexed: 1, skipped: 0, errors: [] }
              : status === 'skipped'
                ? { indexed: 0, skipped: 1, errors: [] }
                : { indexed: 0, skipped: 0, errors: [{ path: String(a.path), error: 'indexing failed' }] }
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          }
        } else {
          const result = await indexVaultSync(Boolean(a.force))
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          }
        }
      }

      if (name === 'status') {
        const stats = getStats()
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  total: stats.total,
                  indexed: stats.indexed,
                  pending: stats.pending,
                  last_indexed: stats.lastIndexed,
                  model: config.apiKey ? config.apiModel : 'Xenova/all-MiniLM-L6-v2 (local)',
                  context_length: contextLength,
                },
                null,
                2
              ),
            },
          ],
        }
      }

      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      }
    }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)

  // Phase 4 & 5: background indexing + watcher (after server is up)
  populateMissingLinks().catch(err => {
    console.warn('[server] links migration error:', err)
  })
  startBackgroundIndexing(contextLength).catch(err => {
    console.warn('[server] background indexing error:', err)
  })
  startWatcher(contextLength)
}

main().catch(err => {
  console.error('[server] fatal error:', err)
  process.exit(1)
})
