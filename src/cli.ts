#!/usr/bin/env node
import Database from 'better-sqlite3';
import Table from 'cli-table3';
import { Command } from 'commander';
import { exec } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { config } from './config.js';
import { getStats, initVecTable, openDb } from './db.js';
import { getContextLength, getEmbeddingDim } from './embedder.js';
import { indexFile, indexVaultSync } from './indexer.js';
import { search } from './searcher.js';

const execAsync = promisify(exec);

const { version } = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf-8'),
) as { version: string };

/** Truncate text at a word boundary, appending '...' if cut */
function truncateAtWord(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > maxLen * 0.7 ? cut.slice(0, lastSpace) : cut) + '...';
}

async function openInObsidian(vaultPath: string, notePaths: string[]): Promise<void> {
  const vaultName = path.basename(vaultPath);
  const obsidianPath =
    process.platform === 'darwin'
      ? '/Applications/Obsidian.app/Contents/MacOS/obsidian'
      : 'obsidian';

  for (let i = 0; i < notePaths.length; i++) {
    const notePath = notePaths[i];
    if (!notePath) continue;
    const escapedPath = notePath.replace(/"/g, '\\"');
    const cmd = `"${obsidianPath}" open "vault=${vaultName}" "path=${escapedPath}" newtab`;

    try {
      await execAsync(cmd);
    } catch (err) {
      console.error(
        `Failed to open ${notePath}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

interface SearchOpts {
  path?: string;
  mode?: 'hybrid' | 'semantic' | 'fulltext' | 'title';
  scope: string[];
  limit: string;
  threshold: string;
  tag: string[];
  related?: boolean;
  depth: string;
  direction?: 'outgoing' | 'backlinks' | 'both';
  snippetLength?: string;
  json?: boolean;
  open?: boolean;
}

interface ReindexOpts {
  force?: boolean;
}
/**
 * Find .obsidian-hybrid-search.db by walking up from dir,
 * read vault_path / api_base_url / api_model from its settings table,
 * and inject them into process.env (only if not already set).
 */
async function discoverConfig(dbPathOpt?: string): Promise<void> {
  let dbFile: string | undefined = dbPathOpt;

  if (!dbFile) {
    let dir = process.cwd();
    while (true) {
      const candidate = path.join(dir, '.obsidian-hybrid-search.db');
      if (existsSync(candidate)) {
        dbFile = candidate;
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break; // reached filesystem root
      dir = parent;
    }
  }

  if (!dbFile) {
    if (!process.env.OBSIDIAN_VAULT_PATH) {
      console.error(
        'Error: Could not find .obsidian-hybrid-search.db\n' +
          'Run this command from inside your Obsidian vault, use --db <path>, or set OBSIDIAN_VAULT_PATH.',
      );
      process.exit(1);
    }
    return; // env vars already set — proceed normally
  }

  try {
    // Open read-only without sqlite-vec (settings table needs no vector extension)
    const db = new Database(dbFile, { readonly: true });
    const get = (key: string) =>
      (
        db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
          | { value: string }
          | undefined
      )?.value;

    const vaultPath = get('vault_path');
    const apiBaseUrl = get('api_base_url');
    const apiModel = get('api_model');
    const ignorePatternsCsv = get('ignore_patterns_csv');
    db.close();

    // Env vars take precedence over DB-stored values
    if (vaultPath && !process.env.OBSIDIAN_VAULT_PATH) {
      process.env.OBSIDIAN_VAULT_PATH = vaultPath;
    }
    if (apiBaseUrl && !process.env.OPENAI_BASE_URL) {
      process.env.OPENAI_BASE_URL = apiBaseUrl;
    }
    if (apiModel && !process.env.OPENAI_EMBEDDING_MODEL) {
      process.env.OPENAI_EMBEDDING_MODEL = apiModel;
    }
    if (ignorePatternsCsv && !process.env.OBSIDIAN_IGNORE_PATTERNS) {
      process.env.OBSIDIAN_IGNORE_PATTERNS = ignorePatternsCsv;
    }

    // Fallback: infer vault path from DB location if not stored in settings
    if (!process.env.OBSIDIAN_VAULT_PATH) {
      process.env.OBSIDIAN_VAULT_PATH = path.dirname(dbFile);
    }
  } catch {
    // DB unreadable — let normal startup errors surface
  }
}

async function init() {
  openDb();
  const [contextLength, embeddingDim] = await Promise.all([getContextLength(), getEmbeddingDim()]);
  initVecTable(embeddingDim);
  return contextLength;
}

const program = new Command()
  .name('obsidian-hybrid-search')
  .description('Hybrid search for your Obsidian vault')
  .version(version)
  .option(
    '--db <path>',
    'Path to .obsidian-hybrid-search.db (auto-discovered from CWD by default)',
  );

program.hook('preAction', async (thisCommand) => {
  const opts = thisCommand.opts();
  await discoverConfig(opts.db as string | undefined);
});

program
  .command('search [query]', { isDefault: true })
  .description('Search the vault (default command)')
  .option(
    '--mode <mode>',
    'Search mode: hybrid|semantic|fulltext|title (applies to text search only)',
    'hybrid',
  )
  .option(
    '--path <path>',
    'Note path for semantic similarity search — always semantic, ignores --mode',
  )
  .option(
    '--scope <scope>',
    'Limit to subfolder(s). Repeatable; prefix with "-" to exclude',
    (v: string, a: string[]) => [...a, v],
    [] as string[],
  )
  .option('--limit <n>', 'Maximum results', '10')
  .option('--threshold <n>', 'Minimum score threshold 0..1', '0')
  .option(
    '--tag <tag>',
    'Filter by tag. Repeatable; prefix with "-" to exclude',
    (v: string, a: string[]) => [...a, v],
    [] as string[],
  )
  .option('--related', 'Graph traversal: show notes linked to/from this note (path input only)')
  .option('--depth <n>', 'Traversal depth for --related mode', '1')
  .option(
    '--direction <direction>',
    'Direction for --related: outgoing|backlinks|both (default: both)',
  )
  .option('--snippet-length <n>', 'Max snippet length in characters (default: 300)')
  .option('--json', 'Output as JSON')
  .option('--open', 'Open results in Obsidian')
  .action(async (query: string | undefined, opts: SearchOpts) => {
    const effectiveInput = opts.path ?? query;
    if (!effectiveInput) {
      program.help();
      return;
    }

    await init();

    const results = await search(effectiveInput, {
      mode: opts.mode,
      scope: opts.scope.length > 0 ? opts.scope : undefined,
      limit: parseInt(opts.limit),
      threshold: parseFloat(opts.threshold),
      tag: opts.tag.length > 0 ? opts.tag : undefined,
      related: opts.related ?? false,
      depth: parseInt(opts.depth),
      direction: opts.direction,
      snippetLength: opts.snippetLength ? parseInt(opts.snippetLength) : undefined,
      notePath: opts.path,
    });

    if (opts.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    if (results.length === 0) {
      console.log('No results found.');
      return;
    }

    // Related mode: depth-centered table
    if (opts.related) {
      const table = new Table({
        head: ['DEPTH', 'PATH', 'SNIPPET'],
        colWidths: [7, 45, 55],
        wordWrap: true,
      });
      for (const r of results) {
        const d = r.depth ?? 0;
        const depthStr = d === 0 ? ' 0 ●' : d > 0 ? `+${d}` : `${d}`;
        const context = r.snippet
          ? truncateAtWord(r.snippet.replace(/\t/g, ' ').replace(/ {2,}/g, ' '), 160)
          : r.title;
        table.push([depthStr, r.path, context]);
      }
      console.log(table.toString());

      if (opts.open) {
        await openInObsidian(
          config.vaultPath,
          results.map((r) => r.path),
        );
      }
      return;
    }

    // Normal search table
    const hasSnippets = results.some((r) => (r.snippet ?? '').trim().length > 0);
    const table = hasSnippets
      ? new Table({
          head: ['SCORE', 'PATH', 'SNIPPET'],
          colWidths: [7, 45, 60],
          wordWrap: true,
        })
      : new Table({
          head: ['SCORE', 'PATH'],
          colWidths: [7, 60],
          wordWrap: true,
        });

    for (const r of results) {
      if (hasSnippets) {
        table.push([r.score.toFixed(2), r.path, (r.snippet ?? '').slice(0, 120)]);
      } else {
        table.push([r.score.toFixed(2), r.path]);
      }
    }

    console.log(table.toString());

    if (opts.open) {
      await openInObsidian(
        config.vaultPath,
        results.map((r) => r.path),
      );
    }
  });

program
  .command('reindex [path]')
  .description('Reindex the vault or a specific file')
  .option('--force', 'Force reindex even if unchanged')
  .action(async (filePath: string | undefined, opts: ReindexOpts) => {
    const contextLength = await init();

    if (filePath) {
      const fullPath = path.join(config.vaultPath, filePath);
      const status = await indexFile(fullPath, contextLength, opts.force);
      console.log(
        JSON.stringify(
          status === 'indexed'
            ? { indexed: 1, skipped: 0, errors: [] }
            : status === 'skipped'
              ? { indexed: 0, skipped: 1, errors: [] }
              : {
                  indexed: 0,
                  skipped: 0,
                  errors: [
                    {
                      path: filePath,
                      error: typeof status === 'object' ? status.error : 'indexing failed',
                    },
                  ],
                },
          null,
          2,
        ),
      );
    } else {
      console.error('Indexing vault...');
      const result = await indexVaultSync(opts.force);
      console.log(JSON.stringify(result, null, 2));
    }
  });

program
  .command('status')
  .description('Show indexing status and configuration')
  .action(async () => {
    const contextLength = await init();
    const stats = getStats();
    console.log(
      JSON.stringify(
        {
          vault: config.vaultPath,
          total: stats.total,
          indexed: stats.indexed,
          pending: stats.pending,
          chunks: stats.chunks,
          links: stats.links,
          last_indexed: stats.lastIndexed,
          ignore_patterns: config.ignorePatterns,
          model:
            config.apiKey || process.env.OPENAI_BASE_URL
              ? config.apiModel
              : 'Xenova/all-MiniLM-L6-v2 (local)',
          context_length: contextLength,
          version,
          recent_activity: stats.recentActivity,
        },
        null,
        2,
      ),
    );
  });

program.parseAsync(process.argv).catch((err) => {
  console.error('Error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
