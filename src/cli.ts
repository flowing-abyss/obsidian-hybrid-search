#!/usr/bin/env node
// organize-imports-ignore
import './preflight.js';
import Database from 'better-sqlite3';
import Table from 'cli-table3';
import { Command } from 'commander';
import { exec } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pc from 'picocolors';
import { parseCliIntegerOption, parseCliNumberOption } from './boundary-validation.js';
import {
  formatSnippetForTable,
  getSearchTableLayout,
  truncatePathMiddle,
  wrapPathForTable,
} from './cli-table-layout.js';
import { config } from './config.js';
import {
  applyDbConfigDefaults,
  checkModelChanged,
  getFailedChunks,
  getDb,
  getStats,
  getStoredEmbeddingDim,
  getStoredModel,
  initVecTable,
  isLikelyDatabaseCorruption,
  openDb,
  saveConfigMeta,
  wipeDatabaseFiles,
  wipeDatabaseSidecars,
} from './db.js';
import { getContextLength, getEmbeddingDim, primeEmbeddingDim } from './embedder.js';
import {
  getIndexingStatus,
  indexFileWithRecovery,
  indexVaultSync,
  populateMissingMarkdownReferences,
  startBackgroundIndexing,
  startWatcher,
} from './indexer.js';
import { runHttpMcpServerCli } from './mcp-http-server.js';
import { runStdioMcpServer } from './mcp-stdio-server.js';
import { ensureMcpServer, formatMcpInfo, getMcpStatus, stopMcpServer } from './mcp-supervisor.js';
import { isAmbiguousNotePathError, readNotes, search } from './searcher.js';
import { handleStdioLine } from './stdio-server.js';

const execAsync = promisify(exec);

const { version } = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf-8'),
) as { version: string };

function failCliValidation(err: unknown): never {
  console.error('Error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
}

function failAmbiguousPath(err: unknown): boolean {
  if (!isAmbiguousNotePathError(err)) return false;
  console.error(`Found ${err.candidates.length} matches:`);
  err.candidates.forEach((candidate, index) => {
    console.error(`  ${index + 1}. ${candidate}`);
  });
  console.error('Use full path to disambiguate');
  process.exit(1);
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseAllowedHostsEnv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter((host) => host.length > 0);
}

function normalizeCliAllowedHosts(hosts: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const host of hosts) {
    const value = host.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

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
  folder: string[];
  limit?: string;
  threshold: string;
  tag: string[];
  frontmatter: string[];
  prop: string[];
  related?: boolean;
  depth: string;
  direction?: 'outgoing' | 'backlinks' | 'both';
  linkType?: 'wiki' | 'markdown' | 'all';
  snippetLength?: string;
  json?: boolean;
  open?: boolean;
  extended?: boolean;
  onlyPaths?: boolean;
  onlyAbsolutePaths?: boolean;
  rerank?: boolean;
  anchors?: boolean;
}

interface ReindexOpts {
  force?: boolean;
}

interface ServeOpts {
  stdio?: boolean;
  http?: boolean;
  host: string;
  port: string;
  allowedHost?: string[];
  allowAnyHost?: boolean;
  foreground?: boolean;
}

/** Walk up from cwd looking for a file/dir with the given name. Returns the containing dir or undefined. */
function walkUpFind(name: string): string | undefined {
  let dir = process.cwd();
  while (true) {
    if (existsSync(path.join(dir, name))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Find .obsidian-hybrid-search.db by walking up from dir,
 * read vault_path / api_base_url / api_model from its settings table,
 * and inject them into process.env (only if not already set).
 */
function discoverConfig(dbPathOpt?: string): void {
  let dbFile: string | undefined = dbPathOpt;

  if (!dbFile) {
    const vaultDir = walkUpFind('.obsidian-hybrid-search.db');
    if (vaultDir) dbFile = path.join(vaultDir, '.obsidian-hybrid-search.db');
  }

  if (!dbFile) {
    if (!process.env.OBSIDIAN_VAULT_PATH) {
      const inferredVault = walkUpFind('.obsidian');
      if (inferredVault) {
        process.env.OBSIDIAN_VAULT_PATH = inferredVault;
      } else {
        console.error(
          'Error: Could not find .obsidian-hybrid-search.db\n' +
            'Run this command from inside your Obsidian vault, use --db <path>, or set OBSIDIAN_VAULT_PATH.',
        );
        process.exit(1);
      }
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
    // Only restore a non-default base URL — the default 'https://api.openai.com/v1'
    // must not be written to process.env, because modelName detection in init()
    // treats any truthy OPENAI_BASE_URL as "remote API configured" and skips local model.
    if (apiBaseUrl && apiBaseUrl !== 'https://api.openai.com/v1' && !process.env.OPENAI_BASE_URL) {
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

async function init({ allowWipe = false }: { allowWipe?: boolean } = {}) {
  openDb();
  applyDbConfigDefaults();

  // Persist config metadata so the DB is self-describing (mirrors server.ts)
  saveConfigMeta({
    vaultPath: config.vaultPath,
    apiBaseUrl: config.apiBaseUrl,
    apiModel: config.apiModel,
  });

  // Check if model changed — only wipe during reindex, not during serve/search/status.
  // Wiping on serve/search would destroy the index whenever env vars are missing (e.g.
  // when Obsidian launches without shell env vars like OPENAI_BASE_URL).
  const modelName = currentModelName();
  if (allowWipe) {
    if (checkModelChanged(modelName)) {
      saveConfigMeta({
        vaultPath: config.vaultPath,
        apiBaseUrl: config.apiBaseUrl,
        apiModel: config.apiModel,
      });
    }
  } else {
    // Read-only path: warn if model differs but do not wipe
    const stored = getStoredModel();
    if (stored && stored !== modelName) {
      process.stderr.write(
        `[warn] Embedding model mismatch: DB has "${stored}", current env has "${modelName}". Semantic search may be degraded. Run reindex to rebuild vectors.\n`,
      );
    }
  }

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
  await populateMissingMarkdownReferences();
  return contextLength;
}

function currentModelName(): string {
  return config.apiKey || process.env.OPENAI_BASE_URL
    ? config.apiModel
    : `local:${config.localModel}`;
}

function restoreDbRuntimeMetadata(modelName: string, embeddingDim: number | null): void {
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

function recoverDbSidecarsForReindex(modelName: string, embeddingDim: number | null): void {
  wipeDatabaseSidecars();
  openDb();
  restoreDbRuntimeMetadata(modelName, embeddingDim);
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
  filterOnlyMode: boolean,
): void {
  const hasSnippets = results.some((r) => (r.snippet ?? '').trim().length > 0);
  const layout = getSearchTableLayout({
    extended,
    filterOnlyMode,
    hasSnippets,
    terminalColumns: process.stdout.columns,
  });

  const heads = [];
  if (!filterOnlyMode) {
    heads.push('SCORE');
  }
  heads.push('PATH');

  if (extended && hasSnippets) heads.push('TAGS/ALIASES', 'SNIPPET');
  else if (extended) heads.push('TAGS/ALIASES');
  else if (hasSnippets) heads.push('SNIPPET');

  const table = new Table({
    head: heads,
    colWidths: layout.colWidths,
    wordWrap: true,
    style: { head: [] },
  });

  for (const r of results) {
    const row = [];
    if (!filterOnlyMode) row.push(colorScore(r.score));
    row.push(
      hasSnippets
        ? wrapPathForTable(r.path, layout.pathColumnWidth - 2)
        : truncatePathMiddle(r.path, layout.pathColumnWidth - 2),
    );
    if (extended && hasSnippets) {
      row.push(
        formatMeta(r),
        formatSnippetForTable(r.snippet ?? '', (layout.snippetColumnWidth ?? 47) - 2),
      );
    } else if (extended) {
      row.push(formatMeta(r));
    } else if (hasSnippets) {
      row.push(formatSnippetForTable(r.snippet ?? '', (layout.snippetColumnWidth ?? 60) - 2));
    }
    table.push(row);
  }
  console.log(table.toString());
}

async function fetchUpdateStatus(): Promise<
  | { state: 'up_to_date' }
  | { state: 'update_available'; latestVersion: string }
  | { state: 'offline' }
> {
  try {
    const signal = AbortSignal.timeout(3000);
    const res = await fetch('https://registry.npmjs.org/obsidian-hybrid-search/latest', { signal });
    if (!res.ok) return { state: 'offline' };
    const data = (await res.json()) as { version: string };
    return data.version !== version
      ? { state: 'update_available', latestVersion: data.version }
      : { state: 'up_to_date' };
  } catch {
    return { state: 'offline' };
  }
}

const program = new Command()
  .name('obsidian-hybrid-search')
  .description('Hybrid search for your Obsidian vault')
  .version(version)
  .option(
    '--db <path>',
    'Path to .obsidian-hybrid-search.db (auto-discovered from CWD by default)',
  );

// eslint-disable-next-line @typescript-eslint/require-await
program.hook('preAction', async (_thisCommand, actionCommand) => {
  const isServeCommand =
    actionCommand.name() === 'serve' || actionCommand.parent?.name() === 'serve';
  if (isServeCommand) return;

  const opts = program.opts<{ db?: string }>();
  discoverConfig(opts.db);
});

program
  .command('mcp')
  .description('Start the MCP server over stdio')
  .action(async () => {
    await runStdioMcpServer();
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
    'Note path for semantic similarity search; with --related, traverses links/backlinks',
  )
  .option(
    '--scope <scope>',
    'Limit to subfolder(s). Repeatable; prefix with "-" to exclude',
    (v: string, a: string[]) => [...a, v],
    [] as string[],
  )
  .option(
    '--folder <folder>',
    'Short for --scope',
    (v: string, a: string[]) => [...a, v],
    [] as string[],
  )
  .option('--limit <n>', 'Maximum results for search/filter modes; --related uses --depth')
  .option('--threshold <n>', 'Minimum score threshold 0..1 for search/path modes', '0')
  .option(
    '--tag <tag>',
    'Filter by tag. Repeatable; prefix with "-" to exclude',
    (v: string, a: string[]) => [...a, v],
    [] as string[],
  )
  .option(
    '--frontmatter <filter>',
    'Filter by frontmatter field (e.g., status:todo). Repeatable; prefix with "-" to exclude',
    (v: string, a: string[]) => [...a, v],
    [] as string[],
  )
  .option(
    '--prop <filter>',
    'Short for --frontmatter',
    (v: string, a: string[]) => [...a, v],
    [] as string[],
  )
  .option('--related', 'Graph traversal: show notes linked to/from this note (path input only)')
  .option('--depth <n>', 'Traversal depth for --related mode', '1')
  .option(
    '--direction <direction>',
    'Direction for --related: outgoing|backlinks|both (default: both)',
  )
  .option('--link-type <type>', 'Graph type for --related: wiki|markdown|all (default: wiki)')
  .option('--snippet-length <n>', 'Max snippet length in characters (default: 300)')
  .option('--json', 'Output as JSON')
  .option('--only-paths', 'Output note paths one per line (for use in pipes)')
  .option(
    '--only-absolute-paths',
    'Output absolute filesystem paths one per line (vault-relative paths prefixed with vault root; useful for Cmd+click in terminal emulators)',
  )
  .option('--open', 'Open results in Obsidian')
  .option('--extended', 'Show tags and aliases column in output table')
  .option(
    '--rerank',
    'Enable cross-encoder re-ranking (downloads ~570MB model on first use, hybrid mode only)',
  )
  .option(
    '--anchors',
    'Include previewAnchors (headingPath, matchText, charStart/charEnd) in JSON output',
  )
  .action(async (queries: string[], opts: SearchOpts) => {
    const effectiveInput = opts.path ?? queries[0];
    const frontmatterFilters = [...opts.frontmatter, ...opts.prop];
    const scopeFilters = [...opts.scope, ...opts.folder];
    const hasFilters =
      frontmatterFilters.length > 0 || opts.tag.length > 0 || scopeFilters.length > 0;
    if (!effectiveInput && !hasFilters) {
      program.help();
      return;
    }

    const isFilterOnlyMode = !effectiveInput && !opts.path;
    // No explicit --limit in filter-only mode → 0 (return all). Otherwise use the specified value or default 10.
    let parsedLimit: number;
    let threshold: number;
    let depth: number;
    let snippetLength: number | undefined;
    try {
      parsedLimit =
        opts.limit !== undefined
          ? parseCliIntegerOption('--limit', opts.limit, { min: 0 })
          : isFilterOnlyMode
            ? 0
            : 10;
      threshold = parseCliNumberOption('--threshold', opts.threshold, { min: 0, max: 1 });
      depth = parseCliIntegerOption('--depth', opts.depth, { min: 0 });
      snippetLength =
        opts.snippetLength !== undefined
          ? parseCliIntegerOption('--snippet-length', opts.snippetLength, { min: 0 })
          : undefined;
      if (
        opts.linkType !== undefined &&
        opts.linkType !== 'wiki' &&
        opts.linkType !== 'markdown' &&
        opts.linkType !== 'all'
      ) {
        throw new Error('Invalid --link-type: expected wiki, markdown, or all');
      }
    } catch (err) {
      failCliValidation(err);
    }

    await init();

    let results;
    try {
      results = await search(effectiveInput ?? '', {
        mode: opts.mode,
        scope: scopeFilters.length > 0 ? scopeFilters : undefined,
        limit: parsedLimit,
        threshold,
        tag: opts.tag.length > 0 ? opts.tag : undefined,
        frontmatter: frontmatterFilters.length > 0 ? frontmatterFilters : undefined,
        related: opts.related ?? false,
        depth,
        direction: opts.direction,
        linkType: opts.linkType,
        snippetLength,
        notePath: opts.path,
        rerank: opts.rerank ?? false,
        anchors: opts.anchors ?? false,
        queries: !opts.path && queries.length > 1 ? queries : undefined,
      });
    } catch (err) {
      failAmbiguousPath(err);
      throw err;
    }

    if (opts.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    if (opts.onlyPaths) {
      for (const r of results) {
        console.log(r.path);
      }
      return;
    }

    if (opts.onlyAbsolutePaths) {
      for (const r of results) {
        console.log(path.join(config.vaultPath, r.path));
      }
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

    printSearchTable(results, opts.extended ?? false, isFilterOnlyMode);

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
    // On a fresh install (no DB yet), always do a full reindex
    if (!filePath && !existsSync(config.dbPath)) {
      opts.force = true;
    }

    if (filePath) {
      const contextLength = await init({ allowWipe: false });
      const fullPath = path.join(config.vaultPath, filePath);
      const modelName = currentModelName();
      const embeddingDim = getStoredEmbeddingDim();
      const status = await indexFileWithRecovery(fullPath, contextLength, opts.force, () =>
        recoverDbSidecarsForReindex(modelName, embeddingDim),
      );
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
      const modelName = currentModelName();
      if (opts.force) {
        wipeDatabaseFiles();
      }
      try {
        await init({ allowWipe: true });
      } catch (err) {
        if (!isLikelyDatabaseCorruption(err)) {
          throw err;
        }
        process.stderr.write(
          '[auto-heal] SQLite index corruption detected during startup; removing WAL/SHM sidecars and retrying.\n',
        );
        wipeDatabaseSidecars();
        await init({ allowWipe: true });
      }
      const embeddingDim = getStoredEmbeddingDim();
      await indexVaultSync(Boolean(opts.force), header, {
        recoverDatabase: () => recoverDbSidecarsForReindex(modelName, embeddingDim),
      });
    }
  });

program
  .command('status')
  .description('Show indexing status and configuration')
  .option('--recent', 'Include recent activity log')
  .option('--errors', 'Include list of chunks that failed to embed')
  .action(async (opts: { recent?: boolean; errors?: boolean }) => {
    const [contextLength, updateInfo] = await Promise.all([init(), fetchUpdateStatus()]);
    const stats = getStats();
    const indexingStatus = getIndexingStatus();
    const output: Record<string, unknown> = {
      vault: config.vaultPath,
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
      context_length: contextLength,
      version,
      ...(updateInfo.state === 'update_available'
        ? {
            latest_version: updateInfo.latestVersion,
            update_command: 'npm install -g obsidian-hybrid-search',
          }
        : updateInfo.state === 'offline'
          ? { version_check: 'offline' }
          : {}),
      ignore_patterns: config.ignorePatterns,
    };
    if (opts.recent) {
      output.recent_activity = stats.recentActivity;
    }
    if (opts.errors) {
      output.errors = getFailedChunks();
    }
    console.log(JSON.stringify(output, null, 2));
    if (!opts.errors && stats.failedChunks > 0) {
      console.warn(
        `⚠️  ${stats.failedChunks} chunk(s) have no embeddings (text search still works). Use --errors to see details.`,
      );
    }
  });

function readRaw(paths: string[]): void {
  const multi = paths.length > 1;
  for (const notePath of paths) {
    const fullPath = path.join(config.vaultPath, notePath);
    if (multi) {
      const header = `── ${notePath} `;
      const line = header + '─'.repeat(Math.max(0, 72 - header.length));
      console.log(`\n${line}\n`);
    }
    if (!existsSync(fullPath)) {
      process.stderr.write(`Note "${notePath}" not found.\n`);
      process.exitCode = 1;
      continue;
    }
    const raw = readFileSync(fullPath, 'utf-8');
    process.stdout.write(raw);
    if (!raw.endsWith('\n')) process.stdout.write('\n');
  }
}

program
  .command('read <paths...>')
  .description('Read note(s) by vault-relative path and print enriched content')
  .option('--snippet-length <n>', 'Max characters of content per note')
  .option('--no-related', 'Skip links and backlinks lookup')
  .option('--json', 'Output as JSON')
  .option('--raw', 'Output raw file content from vault (with frontmatter, no DB lookup)')
  .action(
    async (
      paths: string[],
      opts: { snippetLength?: string; related: boolean; json?: boolean; raw?: boolean },
    ) => {
      if (opts.raw) {
        readRaw(paths);
        return;
      }

      let snippetLength: number | undefined;
      try {
        snippetLength =
          opts.snippetLength !== undefined
            ? parseCliIntegerOption('--snippet-length', opts.snippetLength, { min: 0 })
            : undefined;
      } catch (err) {
        failCliValidation(err);
      }

      await init();

      const results = readNotes(paths, {
        snippetLength,
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

const serveCommand = program
  .command('serve')
  .description('Start a persistent search server')
  .option('--stdio', 'Use Obsidian plugin JSON-lines IPC over stdin/stdout')
  .option('--http', 'Use MCP Streamable HTTP transport (default)')
  .option('--host <host>', 'Host for HTTP MCP server', '127.0.0.1')
  .option('--port <port>', 'Port for HTTP MCP server', '3939')
  .option(
    '--allowed-host <host>',
    'Additional allowed HTTP Host header for MCP clients; repeat for multiple hosts',
    collectOption,
    [],
  )
  .option('--allow-any-host', 'Allow any HTTP Host header by disabling DNS rebinding protection')
  .option('--foreground', 'Run HTTP MCP server in the foreground')
  .action(async (opts: ServeOpts) => {
    const explicitHttp = serveCommand.getOptionValueSource('http') === 'cli';
    const explicitHost = serveCommand.getOptionValueSource('host') === 'cli';
    const explicitPort = serveCommand.getOptionValueSource('port') === 'cli';
    const explicitAllowedHost = serveCommand.getOptionValueSource('allowedHost') === 'cli';
    const explicitAllowAnyHost = serveCommand.getOptionValueSource('allowAnyHost') === 'cli';
    if (
      opts.stdio &&
      (explicitHttp ||
        opts.foreground ||
        explicitHost ||
        explicitPort ||
        explicitAllowedHost ||
        explicitAllowAnyHost)
    ) {
      console.error(
        'Error: --stdio is mutually exclusive with --http, --foreground, --host, --port, --allowed-host, and --allow-any-host',
      );
      process.exit(1);
    }

    discoverConfig(program.opts<{ db?: string }>().db);

    if (opts.stdio) {
      await init();

      const contextLength = await getContextLength();
      startBackgroundIndexing(contextLength).catch((err) => {
        process.stderr.write(`[serve] background indexing error: ${String(err)}\n`);
      });
      startWatcher(contextLength);

      process.stdout.write(JSON.stringify({ ready: true }) + '\n');

      const { createInterface } = await import('node:readline');
      const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

      const cleanup = () => {
        process.exit(0);
      };

      rl.on('close', cleanup);
      rl.on('end', cleanup);

      for await (const line of rl) {
        // Fire-and-forget: process each request concurrently so that a slow in-flight
        // search (e.g. embedding API call) does not block reading and starting the next
        // one.  Responses carry their own `id` field so the plugin dispatches them
        // correctly regardless of arrival order.
        void handleStdioLine(line, search, (s) => process.stdout.write(s + '\n'));
      }
      return;
    }

    let port: number;
    try {
      port = parseCliIntegerOption('--port', opts.port, { min: 1, max: 65535 });
    } catch {
      failCliValidation(new Error('--port must be an integer between 1 and 65535'));
    }

    try {
      const allowedHosts = normalizeCliAllowedHosts([
        ...parseAllowedHostsEnv(process.env.OBSIDIAN_MCP_ALLOWED_HOSTS),
        ...(opts.allowedHost ?? []),
      ]);
      if (opts.foreground) {
        await runHttpMcpServerCli({
          host: opts.host,
          port,
          allowedHosts,
          allowAnyHost: opts.allowAnyHost === true,
        });
        return;
      }

      const result = await ensureMcpServer({
        host: opts.host,
        port,
        allowedHosts,
        allowAnyHost: opts.allowAnyHost === true,
      });
      console.log(formatMcpInfo(result.state, result.started));
    } catch (err) {
      console.error('Error:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

function validateServeManagementOptions(commandName: 'status' | 'stop'): void {
  const explicitStdio = serveCommand.getOptionValueSource('stdio') === 'cli';
  const explicitHttp = serveCommand.getOptionValueSource('http') === 'cli';
  const explicitHost = serveCommand.getOptionValueSource('host') === 'cli';
  const explicitPort = serveCommand.getOptionValueSource('port') === 'cli';
  const explicitForeground = serveCommand.getOptionValueSource('foreground') === 'cli';
  const explicitAllowedHost = serveCommand.getOptionValueSource('allowedHost') === 'cli';
  const explicitAllowAnyHost = serveCommand.getOptionValueSource('allowAnyHost') === 'cli';
  if (
    explicitStdio ||
    explicitHttp ||
    explicitForeground ||
    explicitHost ||
    explicitPort ||
    explicitAllowedHost ||
    explicitAllowAnyHost
  ) {
    console.error(
      `Error: serve ${commandName} cannot be combined with --stdio, --http, --foreground, --host, --port, --allowed-host, or --allow-any-host`,
    );
    process.exit(1);
  }
}

serveCommand
  .command('status')
  .description('Show HTTP MCP server status')
  .action(async () => {
    validateServeManagementOptions('status');
    const state = await getMcpStatus();
    if (state === null) {
      console.log('Obsidian Hybrid Search MCP server is not running');
      return;
    }
    console.log(formatMcpInfo(state, false));
  });

serveCommand
  .command('stop')
  .description('Stop the HTTP MCP server')
  .action(async () => {
    validateServeManagementOptions('stop');
    if (await stopMcpServer()) {
      console.log('Obsidian Hybrid Search MCP server stopped');
      return;
    }
    console.log('Obsidian Hybrid Search MCP server is not running');
  });

program.parseAsync(process.argv).catch((err) => {
  console.error('Error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
