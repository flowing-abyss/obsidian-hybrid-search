import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(__dirname, '..');
const BASE_URL = 'https://notes.andymatuschak.org';
const USER_AGENT = 'obsidian-hybrid-search-evergreen-fixture/1.0';
const MAX_FILENAME_BYTES = 200;

export const DEFAULT_EVERGREEN_SEEDS = [
  'About_these_notes',
  'z5E5QawiXCMbtNtupvxeoEX',
  'z2hQEhqWkdRLL9JUwfawZZx',
  'zR6RRbCfY5rFkiimFnaJZKB',
  'zTDjZQbKAT9pALtsk2HfePx',
  'zKGjQtsTKgscAoq271ZzKqw',
  'zPKTSiU725W9WQCqoVPBcxm',
] as const;

interface RawEvergreenNote {
  slug?: string;
  title?: string;
  contentMarkdown?: string;
  linkedNoteSlugs?: string[];
  mtimeMillis?: number;
}

interface EvergreenNote {
  slug: string;
  title: string;
  contentMarkdown: string;
  linkedNoteSlugs: string[];
  mtimeMillis: number | undefined;
}

interface ImageTarget {
  sourcePath: string;
  vaultPath: string;
}

interface PrepareEvergreenNotesOptions {
  vault?: string;
  repoRoot?: string;
  force?: boolean;
  seeds?: string[];
  politenessDelayMs?: number;
  downloadImages?: boolean;
  fetchPage?: (slug: string) => Promise<string | null>;
  fetchBinary?: (relativePath: string) => Promise<Buffer>;
}

interface PrepareEvergreenNotesResult {
  notesWritten: number;
  imagesDownloaded: number;
  imagesSkipped: number;
  imagesFailed: number;
  vault: string;
}

export async function prepareEvergreenNotesFixture(
  options: PrepareEvergreenNotesOptions = {},
): Promise<PrepareEvergreenNotesResult> {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const vault = resolveFromRoot(repoRoot, options.vault ?? 'fixtures/evergreen-notes/dataset');
  ensureSafeFixtureVault(vault, repoRoot);

  if (!options.force && hasMarkdownFiles(vault)) {
    return {
      notesWritten: 0,
      imagesDownloaded: 0,
      imagesSkipped: 0,
      imagesFailed: 0,
      vault,
    };
  }

  const fetchPage = options.fetchPage ?? fetchNotePage;
  const fetchBinary = options.fetchBinary ?? fetchImage;
  const seeds = options.seeds ?? [...DEFAULT_EVERGREEN_SEEDS];
  const politenessDelayMs = options.politenessDelayMs ?? 300;
  const downloadImages = options.downloadImages ?? true;

  if (options.force) {
    fs.rmSync(vault, { recursive: true, force: true });
  }
  fs.mkdirSync(vault, { recursive: true });

  const visited = new Set<string>();
  const queued = new Set(seeds);
  const queue = [...seeds];
  const notes = new Map<string, EvergreenNote>();
  const imagePaths = new Set<string>();

  while (queue.length > 0) {
    const slug = queue.shift()!;
    queued.delete(slug);
    if (visited.has(slug)) continue;

    const html = await fetchPage(slug);
    visited.add(slug);
    if (html === null) continue;

    const note = extractNoteData(html, slug);
    if (note === null) continue;
    notes.set(note.slug, note);

    for (const imagePath of extractImagePaths(note.contentMarkdown)) {
      imagePaths.add(imagePath);
    }

    for (const linkedSlug of note.linkedNoteSlugs) {
      if (!visited.has(linkedSlug) && !queued.has(linkedSlug)) {
        queue.push(linkedSlug);
        queued.add(linkedSlug);
      }
    }

    if (politenessDelayMs > 0) await delay(politenessDelayMs);
  }

  const notePathBySlug = buildNotePathMap([...notes.values()]);
  const imageTargets = buildImageTargets([...imagePaths].sort((a, b) => a.localeCompare(b)));
  const imagePathBySource = new Map(
    imageTargets.map((target) => [target.sourcePath, target.vaultPath] as const),
  );
  let notesWritten = 0;

  for (const note of notes.values()) {
    const notePath = notePathBySlug.get(note.slug);
    if (!notePath) continue;
    const markdown = renderNoteMarkdown(note, notePathBySlug, imagePathBySource);
    const localPath = path.join(vault, notePath);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, markdown);
    notesWritten++;
  }

  const imageResult = downloadImages
    ? await downloadVaultImages(vault, imageTargets, fetchBinary, politenessDelayMs)
    : { imagesDownloaded: 0, imagesSkipped: 0, imagesFailed: 0 };

  return {
    notesWritten,
    ...imageResult,
    vault,
  };
}

function extractNoteData(html: string, requestedSlug: string): EvergreenNote | null {
  const match =
    /<script id="notetower-initial-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if (!match?.[1]) return null;

  const parsed = JSON.parse(match[1]) as {
    noteCache?: Record<string, { data?: RawEvergreenNote }>;
  };
  const noteCache = parsed.noteCache ?? {};
  const firstEntry = Object.entries(noteCache)[0];
  if (!firstEntry) return null;

  const [fallbackSlug, entry] = firstEntry;
  const data = entry.data ?? {};
  const slug = sanitizeControlCharacters(data.slug ?? fallbackSlug ?? requestedSlug);
  const title = sanitizeControlCharacters(data.title ?? '');
  const contentMarkdown = sanitizeControlCharacters(data.contentMarkdown ?? '');
  return {
    slug,
    title,
    contentMarkdown,
    linkedNoteSlugs: Array.isArray(data.linkedNoteSlugs) ? data.linkedNoteSlugs : [],
    mtimeMillis: data.mtimeMillis,
  };
}

function renderNoteMarkdown(
  note: EvergreenNote,
  notePathBySlug: Map<string, string>,
  imagePathBySource: Map<string, string>,
): string {
  const frontmatter = [
    '---',
    `url: ${JSON.stringify(noteUrl(note.slug))}`,
    note.mtimeMillis === undefined ? undefined : `modified: ${mtimeToDate(note.mtimeMillis)}`,
    '---',
    '',
  ].filter((line) => line !== undefined);
  const content = convertImages(
    convertWikilinks(note.contentMarkdown, notePathBySlug),
    imagePathBySource,
  );

  return `${frontmatter.join('\n')}\n${content.trimEnd()}\n`;
}

function buildNotePathMap(notes: EvergreenNote[]): Map<string, string> {
  const used = new Set<string>();
  const result = new Map<string, string>();
  for (const note of notes) {
    const fileName = uniqueFileName(noteBaseName(note), '.md', used);
    result.set(note.slug, path.posix.join('notes', fileName));
  }
  return result;
}

function noteBaseName(note: EvergreenNote): string {
  return sanitizeFileBaseName(note.title || note.slug);
}

function sanitizeFileBaseName(value: string): string {
  const sanitized = sanitizeControlCharacters(value)
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  return sanitized || 'Untitled';
}

function uniqueFileName(baseName: string, extension: string, used: Set<string>): string {
  const firstBaseName = truncateUtf8(baseName, MAX_FILENAME_BYTES - byteLength(extension));
  let candidate = `${firstBaseName}${extension}`;
  let index = 2;
  while (used.has(candidate)) {
    const suffix = ` ${String(index)}`;
    const candidateBaseName = truncateUtf8(
      baseName,
      MAX_FILENAME_BYTES - byteLength(suffix) - byteLength(extension),
    );
    candidate = `${candidateBaseName}${suffix}${extension}`;
    index++;
  }
  used.add(candidate);
  return candidate;
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = '';
  let bytes = 0;
  for (const char of value) {
    const charBytes = byteLength(char);
    if (bytes + charBytes > maxBytes) break;
    result += char;
    bytes += charBytes;
  }
  return result.trimEnd() || 'Untitled';
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf-8');
}

function buildImageTargets(imagePaths: string[]): ImageTarget[] {
  const used = new Set<string>();
  return imagePaths.map((sourcePath) => {
    const parsed = path.posix.parse(sourcePath);
    const baseName = sanitizeFileBaseName(parsed.name || 'image');
    const extension = sanitizeImageExtension(parsed.ext);
    return {
      sourcePath,
      vaultPath: path.posix.join('files', uniqueFileName(baseName, extension, used)),
    };
  });
}

function sanitizeImageExtension(extension: string): string {
  const sanitized = extension.replace(/[^a-zA-Z0-9.]/g, '');
  return sanitized.startsWith('.') ? sanitized : '';
}

function convertWikilinks(content: string, notePathBySlug: Map<string, string>): string {
  return content.replace(/\[\[([a-zA-Z0-9_%§-]+):::(.*?)\]\]/g, (_match, slug, title) => {
    const notePath = notePathBySlug.get(String(slug));
    const linkText =
      notePath === undefined
        ? sanitizeLinkText(String(title)) || String(slug)
        : notePath.replace(/^notes\//, '').replace(/\.md$/, '');
    return `[[${linkText}]]`;
  });
}

function sanitizeLinkText(value: string): string {
  return sanitizeControlCharacters(value).replace(/\s+/g, ' ').trim();
}

function convertImages(content: string, imagePathBySource: Map<string, string>): string {
  return content.replace(/!\[[^\]]*]\(([^)]+)\)/g, (match, rawPath) => {
    const sourcePath = normalizeImagePath(String(rawPath));
    if (!sourcePath) return match;
    const targetPath = imagePathBySource.get(sourcePath);
    return targetPath ? `![[${targetPath}]]` : match;
  });
}

function extractImagePaths(content: string): string[] {
  const paths = new Set<string>();
  for (const match of content.matchAll(/!\[[^\]]*]\(([^)]+)\)/g)) {
    const imagePath = normalizeImagePath(match[1]);
    if (imagePath) paths.add(imagePath);
  }
  return [...paths];
}

function normalizeImagePath(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const withoutFragment = raw.split('#')[0]?.split('?')[0]?.trim();
  if (!withoutFragment || /^[a-z]+:/i.test(withoutFragment) || path.isAbsolute(withoutFragment)) {
    return undefined;
  }
  const normalized = path.posix.normalize(decodeURIComponent(withoutFragment));
  if (normalized.startsWith('../') || normalized === '..') return undefined;
  return normalized;
}

async function downloadVaultImages(
  vault: string,
  imageTargets: ImageTarget[],
  fetchBinary: (relativePath: string) => Promise<Buffer>,
  politenessDelayMs: number,
): Promise<
  Pick<PrepareEvergreenNotesResult, 'imagesDownloaded' | 'imagesSkipped' | 'imagesFailed'>
> {
  let imagesDownloaded = 0;
  let imagesSkipped = 0;
  let imagesFailed = 0;

  for (const imageTarget of imageTargets) {
    const localPath = path.join(vault, imageTarget.vaultPath);
    if (fs.existsSync(localPath)) {
      imagesSkipped++;
      continue;
    }

    try {
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      fs.writeFileSync(localPath, await fetchBinary(imageTarget.sourcePath));
      imagesDownloaded++;
    } catch {
      imagesFailed++;
    }

    if (politenessDelayMs > 0) await delay(politenessDelayMs);
  }

  return { imagesDownloaded, imagesSkipped, imagesFailed };
}

async function fetchNotePage(slug: string): Promise<string | null> {
  const response = await fetch(`${BASE_URL}/${encodeURIComponent(slug)}`, {
    headers: { 'user-agent': USER_AGENT },
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Failed to fetch note ${slug}: HTTP ${String(response.status)}`);
  }
  return await response.text();
}

async function fetchImage(relativePath: string): Promise<Buffer> {
  const response = await fetch(
    `${BASE_URL}/${relativePath.split('/').map(encodeURIComponent).join('/')}`,
    {
      headers: { 'user-agent': USER_AGENT },
    },
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch image ${relativePath}: HTTP ${String(response.status)}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function noteUrl(slug: string): string {
  return `${BASE_URL}/${encodeURIComponent(slug)}`;
}

function mtimeToDate(mtimeMillis: number): string {
  return new Date(mtimeMillis).toISOString().slice(0, 10);
}

function sanitizeControlCharacters(value: string): string {
  return [...value]
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
    })
    .join('');
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

function ensureSafeFixtureVault(vault: string, repoRoot: string): void {
  const absVault = path.resolve(vault);
  const fixturesRoot = path.resolve(repoRoot, 'fixtures');
  const relative = path.relative(fixturesRoot, absVault);
  if (relative.startsWith('..') || path.isAbsolute(relative) || relative === '') {
    throw new Error(`Refusing to recreate vault outside fixtures/: ${vault}`);
  }
}

function resolveFromRoot(repoRoot: string, value: string): string {
  return path.isAbsolute(value) ? value : path.join(repoRoot, value);
}

function parseArgs(): {
  vault: string | undefined;
  force: boolean;
  noImages: boolean;
  delayMs: number | undefined;
} {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx === -1 ? undefined : args[idx + 1];
  };
  const delayRaw = get('--delay-ms');
  return {
    vault: get('--vault'),
    force: args.includes('--force'),
    noImages: args.includes('--no-images'),
    delayMs: delayRaw === undefined ? undefined : parseNonNegativeInteger(delayRaw, '--delay-ms'),
  };
}

function parseNonNegativeInteger(raw: string, flag: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid ${flag}: expected non-negative integer, got "${raw}"`);
  }
  return Number(raw);
}

async function main(): Promise<void> {
  try {
    const args = parseArgs();
    const result = await prepareEvergreenNotesFixture({
      vault: args.vault,
      force: args.force,
      downloadImages: !args.noImages,
      politenessDelayMs: args.delayMs,
    });
    console.log(`[evergreen] notes written:     ${String(result.notesWritten)}`);
    console.log(`[evergreen] images downloaded: ${String(result.imagesDownloaded)}`);
    console.log(`[evergreen] images skipped:    ${String(result.imagesSkipped)}`);
    console.log(`[evergreen] images failed:     ${String(result.imagesFailed)}`);
    console.log(`[evergreen] vault:             ${result.vault}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}
