#!/usr/bin/env node
import { Command } from 'commander'
import Table from 'cli-table3'
import path from 'node:path'
import { existsSync } from 'node:fs'
import Database from 'better-sqlite3'
import { openDb, initVecTable, getStats } from './db.js'
import { getContextLength, getEmbeddingDim } from './embedder.js'
import { search } from './searcher.js'
import { indexVaultSync, indexFile } from './indexer.js'
import { config } from './config.js'

/**
 * Find .obsidian-hybrid-search.db by walking up from dir,
 * read vault_path / api_base_url / api_model from its settings table,
 * and inject them into process.env (only if not already set).
 */
async function discoverConfig(dbPathOpt?: string): Promise<void> {
  let dbFile: string | undefined = dbPathOpt

  if (!dbFile) {
    let dir = process.cwd()
    while (true) {
      const candidate = path.join(dir, '.obsidian-hybrid-search.db')
      if (existsSync(candidate)) {
        dbFile = candidate
        break
      }
      const parent = path.dirname(dir)
      if (parent === dir) break // reached filesystem root
      dir = parent
    }
  }

  if (!dbFile) {
    if (!process.env.OBSIDIAN_VAULT_PATH) {
      console.error(
        'Error: Could not find .obsidian-hybrid-search.db\n' +
        'Run this command from inside your Obsidian vault, use --db <path>, or set OBSIDIAN_VAULT_PATH.'
      )
      process.exit(1)
    }
    return // env vars already set — proceed normally
  }

  try {
    // Open read-only without sqlite-vec (settings table needs no vector extension)
    const db = new Database(dbFile, { readonly: true })
    const get = (key: string) =>
      (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value

    const vaultPath = get('vault_path')
    const apiBaseUrl = get('api_base_url')
    const apiModel = get('api_model')
    const ignorePatternsCsv = get('ignore_patterns_csv')
    db.close()

    // Env vars take precedence over DB-stored values
    if (vaultPath && !process.env.OBSIDIAN_VAULT_PATH) {
      process.env.OBSIDIAN_VAULT_PATH = vaultPath
    }
    if (apiBaseUrl && !process.env.OPENAI_BASE_URL) {
      process.env.OPENAI_BASE_URL = apiBaseUrl
    }
    if (apiModel && !process.env.OPENAI_EMBEDDING_MODEL) {
      process.env.OPENAI_EMBEDDING_MODEL = apiModel
    }
    if (ignorePatternsCsv && !process.env.OBSIDIAN_IGNORE_PATTERNS) {
      process.env.OBSIDIAN_IGNORE_PATTERNS = ignorePatternsCsv
    }

    // Fallback: infer vault path from DB location if not stored in settings
    if (!process.env.OBSIDIAN_VAULT_PATH) {
      process.env.OBSIDIAN_VAULT_PATH = path.dirname(dbFile)
    }
  } catch (err) {
    // DB unreadable — let normal startup errors surface
  }
}

async function init() {
  openDb()
  const [contextLength, embeddingDim] = await Promise.all([
    getContextLength(),
    getEmbeddingDim(),
  ])
  initVecTable(embeddingDim)
  return contextLength
}

const program = new Command()
  .name('obsidian-hybrid-search')
  .description('Hybrid search for your Obsidian vault')
  .version('0.1.0')
  .option('--db <path>', 'Path to .obsidian-hybrid-search.db (auto-discovered from CWD by default)')

program.hook('preAction', async (thisCommand) => {
  const opts = thisCommand.opts()
  await discoverConfig(opts.db as string | undefined)
})

program
  .command('search [query]', { isDefault: true })
  .description('Search the vault (default command)')
  .option('--mode <mode>', 'Search mode: hybrid|semantic|fulltext|title', 'hybrid')
  .option('--scope <scope>', 'Limit to a subfolder, e.g. notes/pkm/')
  .option('--limit <n>', 'Maximum results', '10')
  .option('--threshold <n>', 'Minimum score threshold 0..1', '0')
  .option('--tag <tag>', 'Filter by tag, e.g. pkm or note/basic/primary')
  .option('--json', 'Output as JSON')
  .action(async (query: string | undefined, opts) => {
    if (!query) {
      program.help()
      return
    }

    await init()

    const results = await search(query, {
      mode: opts.mode,
      scope: opts.scope,
      limit: parseInt(opts.limit),
      threshold: parseFloat(opts.threshold),
      tag: opts.tag,
    })

    if (opts.json) {
      console.log(JSON.stringify(results, null, 2))
      return
    }

    if (results.length === 0) {
      console.log('No results found.')
      return
    }

    const hasSnippets = results.some(r => (r.snippet ?? '').trim().length > 0)
    const table = hasSnippets
      ? new Table({ head: ['SCORE', 'PATH', 'SNIPPET'], colWidths: [7, 45, 60], wordWrap: true })
      : new Table({ head: ['SCORE', 'PATH'], colWidths: [7, 60], wordWrap: true })

    for (const r of results) {
      if (hasSnippets) {
        table.push([r.score.toFixed(2), r.path, (r.snippet ?? '').slice(0, 120)])
      } else {
        table.push([r.score.toFixed(2), r.path])
      }
    }

    console.log(table.toString())
  })

program
  .command('reindex [path]')
  .description('Reindex the vault or a specific file')
  .option('--force', 'Force reindex even if unchanged')
  .action(async (filePath: string | undefined, opts) => {
    const contextLength = await init()

    if (filePath) {
      const fullPath = path.join(config.vaultPath, filePath)
      const status = await indexFile(fullPath, contextLength, opts.force)
      console.log(JSON.stringify(
        status === 'indexed'
          ? { indexed: 1, skipped: 0, errors: [] }
          : status === 'skipped'
            ? { indexed: 0, skipped: 1, errors: [] }
            : { indexed: 0, skipped: 0, errors: [{ path: filePath, error: typeof status === 'object' ? status.error : 'indexing failed' }] },
        null, 2
      ))
    } else {
      console.error('Indexing vault...')
      const result = await indexVaultSync(opts.force)
      console.log(JSON.stringify(result, null, 2))
    }
  })

program
  .command('status')
  .description('Show indexing status and configuration')
  .action(async () => {
    const contextLength = await init()
    const stats = getStats()
    console.log(JSON.stringify({
      vault: config.vaultPath,
      total: stats.total,
      indexed: stats.indexed,
      pending: stats.pending,
      last_indexed: stats.lastIndexed,
      model: config.apiKey ? config.apiModel : 'Xenova/all-MiniLM-L6-v2 (local)',
      context_length: contextLength,
    }, null, 2))
  })

program.parseAsync(process.argv).catch(err => {
  console.error('Error:', err.message)
  process.exit(1)
})
