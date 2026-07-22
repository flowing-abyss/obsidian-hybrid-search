import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const SOURCE_REPO = 'https://github.com/obsidianmd/obsidian-help.git';
const GIT_EXECUTABLE = process.env.GIT_EXECUTABLE ?? 'git';

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

  if (!options.force && hasMarkdownFiles(vault)) {
    return {
      copied: false,
      source: options.sourceDir ? path.resolve(options.sourceDir) : SOURCE_REPO,
      vault,
    };
  }

  const tempDir = options.sourceDir
    ? undefined
    : fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'ohs-obsidian-help-'));
  const source = options.sourceDir ? path.resolve(options.sourceDir) : cloneSource(tempDir!);

  try {
    const enDir = path.join(source, 'en');
    if (!fs.existsSync(enDir)) {
      throw new Error(`Obsidian Help source does not contain en/: ${source}`);
    }
    fs.rmSync(vault, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(vault), { recursive: true });
    fs.cpSync(enDir, vault, { recursive: true });
    return { copied: true, source, vault };
  } finally {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function cloneSource(tempDir: string): string {
  const target = path.join(tempDir, 'obsidian-help');
  const result = spawnSync(GIT_EXECUTABLE, ['clone', '--depth', '1', SOURCE_REPO, target], {
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(`Failed to clone ${SOURCE_REPO}: ${detail}`);
  }
  return target;
}

function hasMarkdownFiles(dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      if (entry.isFile() && entry.name.endsWith('.md')) return true;
    }
  }
  return false;
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
