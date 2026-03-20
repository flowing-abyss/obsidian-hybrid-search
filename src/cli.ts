#!/usr/bin/env node
import Database from 'better-sqlite3';
import Table from 'cli-table3';
import { Command } from 'commander';
import { exec } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pc from 'picocolors';
import { config } from './config.js';
import {
  checkModelChanged,
  getStats,
  getStoredEmbeddingDim,
  initVecTable,
  openDb,
  saveConfigMeta,
  wipeDatabaseFiles,
} from './db.js';
import { LOCAL_MODEL, getContextLength, getEmbeddingDim, primeEmbeddingDim } from './embedder.js';
import { getIndexingStatus, indexFile, indexVaultSync } from './indexer.js';
import { readNotes, search } from './searcher.js';

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

  for (const notePath of notePaths) {
    if (!notePath) continue;
    const normalizedPath = notePath.normalize('NFC');
    const escapedPath = normalizedPath.replace(/"/g, '\\"');
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
  extended?: boolean;
  rerank?: boolean;
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
    const ignorePatternsJson = get('ignore_patterns');
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
    if (ignorePatternsJson && !process.env.OBSIDIAN_IGNORE_PATTERNS) {
      try {
        const patterns = JSON.parse(ignorePatternsJson) as string[];
        process.env.OBSIDIAN_IGNORE_PATTERNS = patterns.join(',');
      } catch {
        // Invalid JSON, ignore
      }
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

  // Persist config metadata so the DB is self-describing (mirrors server.ts)
  saveConfigMeta({
    vaultPath: config.vaultPath,
    apiBaseUrl: config.apiBaseUrl,
    apiModel: config.apiModel,
    ignorePatternsCsv: config.ignorePatterns.join(','),
  });

  // Check if model changed — wipes DB if so, forces full reindex (mirrors server.ts)
  const modelName =
    config.apiKey || process.env.OPENAI_BASE_URL ? config.apiModel : `local:${LOCAL_MODEL}`;
  checkModelChanged(modelName);

  // Read stored dim from DB first — avoids an API round-trip when the vault was
  // already indexed.  This is the common case and ensures that fulltext / title
  // searches (which never need the embedding API) keep working when offline.
  // Only fall back to getEmbeddingDim() on a fresh install where no dim is stored yet.
  const storedDim = getStoredEmbeddingDim();
  const [contextLength, apiDim] = await Promise.all([
    getContextLength(),
    storedDim === null
      ? getEmbeddingDim().catch((err: unknown) => {
          console.error(
            '[cli] embedding API unavailable — semantic search and indexing disabled,' +
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
  }
  return contextLength;
}

/** Color-code a score value based on relevance thresholds. */
function colorScore(score: number): string {
  const s = score.toFixed(2);
  if (score >= 0.8) return pc.green(s);
  if (score >= 0.5) return pc.yellow(s);
  if (score >= 0.2) return s;
  return pc.blackBright(s);
}

/** Format tags and aliases into a single TAGS/ALIASES cell for --extended output. */
function formatMeta(r: { tags: string[]; aliases: string[] }): string {
  return [...r.tags.map((t) => `#${t}`), ...r.aliases].join('\n');
}

/** Build and print the related-mode depth table. */
function printRelatedTable(
  results: Awaited<ReturnType<typeof import('./searcher.js').search>>,
  extended: boolean,
): void {
  const table = extended
    ? new Table({
        head: ['DEPTH', 'PATH', 'TAGS/ALIASES', 'SNIPPET'],
        colWidths: [7, 40, 20, 40],
        wordWrap: true,
        style: { head: [] },
      })
    : new Table({
        head: ['DEPTH', 'PATH', 'SNIPPET'],
        colWidths: [7, 45, 55],
        wordWrap: true,
        style: { head: [] },
      });
  for (const r of results) {
    const d = r.depth ?? 0;
    const depthStr = d === 0 ? ' 0 ●' : d > 0 ? `+${d}` : `${d}`;
    const context = r.snippet
      ? truncateAtWord(r.snippet.replace(/\t/g, ' ').replace(/ {2,}/g, ' '), 160)
      : r.title;
    if (extended) {
      table.push([depthStr, r.path, formatMeta(r), context]);
    } else {
      table.push([depthStr, r.path, context]);
    }
  }
  console.log(table.toString());
}

/** Build and print the normal search results table. */
function printSearchTable(
  results: Awaited<ReturnType<typeof import('./searcher.js').search>>,
  extended: boolean,
): void {
  const hasSnippets = results.some((r) => (r.snippet ?? '').trim().length > 0);
  let table: InstanceType<typeof Table>;
  if (extended && hasSnippets) {
    table = new Table({
      head: ['SCORE', 'PATH', 'TAGS/ALIASES', 'SNIPPET'],
      colWidths: [7, 38, 20, 47],
      wordWrap: true,
      style: { head: [] },
    });
  } else if (extended) {
    table = new Table({
      head: ['SCORE', 'PATH', 'TAGS/ALIASES'],
      colWidths: [7, 50, 25],
      wordWrap: true,
      style: { head: [] },
    });
  } else if (hasSnippets) {
    table = new Table({
      head: ['SCORE', 'PATH', 'SNIPPET'],
      colWidths: [7, 45, 60],
      wordWrap: true,
      style: { head: [] },
    });
  } else {
    table = new Table({
      head: ['SCORE', 'PATH'],
      colWidths: [7, 60],
      wordWrap: true,
      style: { head: [] },
    });
  }
  for (const r of results) {
    if (extended && hasSnippets) {
      table.push([colorScore(r.score), r.path, formatMeta(r), r.snippet ?? '']);
    } else if (extended) {
      table.push([colorScore(r.score), r.path, formatMeta(r)]);
    } else if (hasSnippets) {
      table.push([colorScore(r.score), r.path, r.snippet ?? '']);
    } else {
      table.push([colorScore(r.score), r.path]);
    }
  }
  console.log(table.toString());
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
  .command('search [queries...]', { isDefault: true })
  .description('Search the vault (default command). Pass multiple queries for fan-out search.')
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
  .option('--extended', 'Show tags and aliases column in output table')
  .option(
    '--rerank',
    'Enable cross-encoder re-ranking (downloads ~32MB model on first use, hybrid mode only)',
  )
  .action(async (queries: string[], opts: SearchOpts) => {
    const effectiveInput = opts.path ?? queries[0];
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
      snippetLength: opts.snippetLength ? parseInt(opts.snippetLength, 10) : undefined,
      notePath: opts.path,
      rerank: opts.rerank ?? false,
      queries: !opts.path && queries.length > 1 ? queries : undefined,
    });

    if (opts.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    if (results.length === 0) {
      console.log('No results found.');
      return;
    }

    if (opts.related) {
      printRelatedTable(results, opts.extended ?? false);
      if (opts.open) {
        await openInObsidian(
          config.vaultPath,
          results.map((r) => r.path),
        );
      }
      return;
    }

    printSearchTable(results, opts.extended ?? false);

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
    if (opts.force && !filePath) {
      wipeDatabaseFiles();
    }
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
      const header = opts.force ? 'Recreating database and indexing vault...' : 'Indexing vault...';
      await indexVaultSync(opts.force, header);
    }
  });

program
  .command('status')
  .description('Show indexing status and configuration')
  .option('--recent', 'Include recent activity log')
  .action(async (opts: { recent?: boolean }) => {
    const contextLength = await init();
    const stats = getStats();
    const indexingStatus = getIndexingStatus();
    const output: Record<string, unknown> = {
      vault: config.vaultPath,
      total: stats.total,
      indexed: stats.indexed,
      pending: stats.pending + indexingStatus.queued,
      chunks: stats.chunks,
      links: stats.links,
      last_indexed: stats.lastIndexed,
      db_size_mb:
        stats.dbSizeBytes !== null ? Math.round((stats.dbSizeBytes / 1024 / 1024) * 10) / 10 : null,
      model: stats.embeddingModel,
      embedding_dim: stats.embeddingDim,
      context_length: contextLength,
      version,
      ignore_patterns: config.ignorePatterns,
    };
    if (opts.recent) {
      output.recent_activity = stats.recentActivity;
    }
    console.log(JSON.stringify(output, null, 2));
    if (stats.failedChunks > 0) {
      console.warn(
        `⚠️  ${stats.failedChunks} chunk(s) have no embeddings (text search still works)`,
      );
    }
  });

program
  .command('read <paths...>')
  .description('Read note(s) by vault-relative path and print enriched content')
  .option('--snippet-length <n>', 'Max characters of content per note')
  .option('--no-related', 'Skip links and backlinks lookup')
  .option('--json', 'Output as JSON')
  .action(
    async (paths: string[], opts: { snippetLength?: string; related: boolean; json?: boolean }) => {
      await init();
      const results = readNotes(paths, {
        snippetLength: opts.snippetLength ? parseInt(opts.snippetLength, 10) : undefined,
        related: opts.related,
      });

      if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }

      const multi = results.length > 1;
      for (const r of results) {
        if (multi) {
          const header = `── ${r.path} `;
          const line = header + '─'.repeat(Math.max(0, 72 - header.length));
          console.log(`\n${line}\n`);
        }
        if (!r.found) {
          console.log(multi ? 'Not found.' : `Note "${r.path}" not found.`);
          if (r.suggestions.length > 0) {
            console.log('Did you mean:');
            for (const s of r.suggestions) {
              console.log(`  · ${s}`);
            }
          }
          continue;
        }
        process.stdout.write(r.content);
        if (!r.content.endsWith('\n')) process.stdout.write('\n');
      }
    },
  );

program.parseAsync(process.argv).catch((err) => {
  console.error('Error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
