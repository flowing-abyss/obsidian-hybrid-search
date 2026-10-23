import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import corpus from './obsidian-help-corpus.json' with { type: 'json' };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const SOURCE_REPO = corpus.repository;

interface PrepareObsidianHelpOptions {
  vault: string;
  repoRoot?: string;
  sourceDir?: string;
  force?: boolean;
}

interface PrepareObsidianHelpResult {
  copied: boolean;
  source: string;
  vault: string;
}

export function prepareObsidianHelpFixture(
  options: PrepareObsidianHelpOptions,
): PrepareObsidianHelpResult {
  const root = options.repoRoot ?? repoRoot;
  const vault = path.resolve(options.vault);
  ensureSafeFixtureVault(vault, root);

  if (!options.force && matchesCorpus(vault, corpus.files)) {
    return {
      copied: false,
      source: options.sourceDir ? path.resolve(options.sourceDir) : SOURCE_REPO,
      vault,
    };
  }

  const tempDir = options.sourceDir
    ? undefined
    : fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'ohs-obsidian-help-'));
  try {
    const source = options.sourceDir ? path.resolve(options.sourceDir) : cloneSource(tempDir!);
    const enDir = path.join(source, 'en');
    if (!matchesCorpus(enDir, corpus.files))
      throw new Error(`Source does not match pinned corpus ${corpus.revision}: ${source}`);
    fs.rmSync(vault, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(vault), { recursive: true });
    fs.cpSync(enDir, vault, { recursive: true });
    return { copied: true, source, vault };
  } finally {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function git(args: string[]): string {
  // Git is a documented developer prerequisite; fixed arguments never invoke a shell.
  // eslint-disable-next-line sonarjs/no-os-command-from-path
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.error || result.status !== 0)
    throw new Error(`Git failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}

function cloneSource(tempDir: string): string {
  const target = path.join(tempDir, 'obsidian-help');
  git(['init', target]);
  git(['-C', target, 'fetch', '--depth', '1', SOURCE_REPO, corpus.revision]);
  // This separate repository must materialize the pinned LF blobs regardless of
  // the developer's global or environment-supplied checkout conversion policy.
  git([
    '-C',
    target,
    '-c',
    'core.autocrlf=false',
    '-c',
    'core.eol=lf',
    'checkout',
    '--detach',
    'FETCH_HEAD',
  ]);
  if (git(['-C', target, 'rev-parse', 'HEAD']) !== corpus.revision)
    throw new Error('Unexpected corpus revision');
  return target;
}

export function matchesCorpus(dir: string, expectedFiles: Record<string, string>): boolean {
  if (!fs.existsSync(dir)) return false;
  const found = new Map<string, string>();
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`Symlinks are not allowed in pinned corpus: ${full}`);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        const bytes = fs.readFileSync(full);
        const hash = createHash('sha1')
          .update(`blob ${bytes.length}\0`)
          .update(bytes)
          .digest('hex');
        found.set(path.relative(dir, full).split(path.sep).join('/'), hash);
      }
    }
  };
  walk(dir);
  return (
    found.size === Object.keys(expectedFiles).length &&
    Object.entries(expectedFiles).every(([file, hash]) => found.get(file) === hash)
  );
}

function ensureSafeFixtureVault(vault: string, root: string): void {
  const fixturesRoot = path.resolve(root, 'fixtures');
  const relative = path.relative(fixturesRoot, vault);
  if (relative.startsWith('..') || path.isAbsolute(relative) || relative === '') {
    throw new Error(`Refusing to recreate vault outside fixtures/: ${vault}`);
  }
}

function parseArgs(): { vault: string; sourceDir: string | undefined; force: boolean } {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx === -1 ? undefined : args[idx + 1];
  };
  const vaultArg = get('--vault') ?? 'fixtures/obsidian-help/dataset';
  const sourceDirArg = get('--source-dir');
  return {
    vault: path.isAbsolute(vaultArg) ? vaultArg : path.join(repoRoot, vaultArg),
    sourceDir: sourceDirArg
      ? path.isAbsolute(sourceDirArg)
        ? sourceDirArg
        : path.join(repoRoot, sourceDirArg)
      : undefined,
    force: args.includes('--force'),
  };
}

function main(): void {
  try {
    const args = parseArgs();
    const result = prepareObsidianHelpFixture(args);
    console.log(`[obsidian-help] copied: ${String(result.copied)}`);
    console.log(`[obsidian-help] source: ${result.source}`);
    console.log(`[obsidian-help] vault:  ${result.vault}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
