import ignore, { type Ignore } from 'ignore';
import { lstatSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import path from 'node:path';
import { config } from '../runtime/config.js';
import { resolveGitContext, type GitContext } from './git-context.js';

const OPERATIONAL_IGNORE_PATTERNS = ['.obsidian/**', '.obsidian-hybrid-search.db*'];
// Bump when ignore-selection semantics change. Notes that only the new matcher ignores
// are then swept as newly ignored (links kept) rather than as files deleted from disk.
const IGNORE_MATCHER_VERSION = 4;

interface GitignoreLayer {
  kind: 'gitignore' | 'exclude';
  sourcePath: string;
  baseGitPath: string;
  content: string;
  matcher: Ignore;
  directMatchers: Map<string, Ignore>;
}

interface ExplicitMatcher {
  ignores(relPath: string): boolean;
}

type ScopedAncestors = ReadonlyMap<string, ReadonlySet<string>>;

export interface IgnorePolicy {
  isIgnored(relPath: string): boolean;
  signature(): string;
  readonly controlWatchFiles: readonly string[];
}

function normalizeRelPath(relPath: string): string {
  return relPath
    .replaceAll(path.sep, '/')
    .replace(/^\.\/+/, '')
    .normalize('NFD');
}

function normalizePattern(pattern: string): string {
  return pattern.trim().replaceAll(path.sep, '/').normalize('NFD');
}

function matchesLegacyIgnorePattern(relPath: string, pattern: string): boolean {
  const normalized = normalizeRelPath(relPath);
  const normalizedPattern = normalizePattern(pattern);
  if (!normalizedPattern) return false;
  if (normalizedPattern.endsWith('/**')) {
    const prefix = normalizedPattern.slice(0, -3);
    return normalized === prefix || normalized.startsWith(prefix + '/');
  }
  if (normalizedPattern.startsWith('*.')) {
    const ext = normalizedPattern.slice(1);
    return normalized.endsWith(ext) || path.posix.basename(normalized).endsWith(ext);
  }
  return normalized === normalizedPattern || normalized.startsWith(normalizedPattern + '/');
}

// The root-anchored matcher compares everything except a trailing `/**` or a leading
// `*.` as a literal string, so a wildcard anywhere else (`**/node_modules/**`,
// `Archive/*/old/**`) can never match a real path. Those patterns get gitignore
// semantics instead. Negations stay literal: stored patterns are restored sorted, so
// an order-dependent `!` rule would behave differently between the CLI and the server.
function isGlobPattern(normalizedPattern: string): boolean {
  if (normalizedPattern.startsWith('!')) return false;
  let literal = normalizedPattern;
  if (literal.endsWith('/**')) literal = literal.slice(0, -3);
  else if (literal.startsWith('*.')) literal = literal.slice(1);
  return literal.includes('*') || literal.includes('?');
}

function normalizeExplicitPattern(pattern: string): string {
  const normalized = normalizePattern(pattern).replace(/^\.\/+/, '');
  if (isGlobPattern(normalized)) return normalized;
  // `/templates/**`, `./templates/**` and `templates/` all mean the root-level folder.
  return stripTrailingSlashes(stripLeadingSlashes(normalized));
}

// `dir/**` does not match `dir/` itself under gitignore rules, so patterns of that shape
// also get a directory form. A lone segment is unanchored in gitignore, hence the leading
// slash that keeps `plugin-*/**` and `.obsidian/**` at the vault root.
function globDirectoryForm(pattern: string): string[] {
  if (!pattern.endsWith('/**')) return [];
  const dir = pattern.slice(0, -3);
  return [dir.includes('/') ? `${dir}/` : `/${dir}/`];
}

function createExplicitMatcher(patterns: readonly string[]): ExplicitMatcher {
  const normalized = patterns.map(normalizeExplicitPattern).filter(Boolean);
  const rootAnchored = normalized.filter((pattern) => !isGlobPattern(pattern));
  // Case-sensitive, like the root-anchored patterns next to it.
  const globMatcher = ignore({ ignorecase: false }).add(
    normalized.filter(isGlobPattern).flatMap((pattern) => [pattern, ...globDirectoryForm(pattern)]),
  );
  return {
    ignores(relPath: string): boolean {
      const normalizedPath = normalizeRelPath(relPath);
      if (!normalizedPath) return false;
      return (
        rootAnchored.some((pattern) => matchesLegacyIgnorePattern(normalizedPath, pattern)) ||
        globMatcher.ignores(normalizedPath)
      );
    },
  };
}

function createMatcher(patterns: readonly string[]): Ignore {
  const normalized = patterns.map(normalizePattern).filter(Boolean);
  return ignore().add(normalized.flatMap((pattern) => [pattern, ...globDirectoryForm(pattern)]));
}

// A directory is pruned only when a rule matches the directory itself. Probing it with
// a made-up file name is not equivalent: `_*` or `*.md` match the probe in every folder,
// and a `!` rule can re-include a real note next to it.
function matcherIgnores(matcher: Ignore, relPath: string): boolean {
  const normalized = normalizeRelPath(relPath);
  if (!normalized) return false;
  return matcher.ignores(normalized);
}

function toLayerRelativePath(relPath: string, baseRelPath: string): string | null {
  const normalized = normalizeRelPath(relPath);
  if (!baseRelPath) return normalized;
  if (normalized === baseRelPath) return '';
  const prefix = baseRelPath + '/';
  if (!normalized.startsWith(prefix)) return null;
  return normalized.slice(prefix.length);
}

function readGitignoreLayer(
  fullPath: string,
  baseGitPath: string,
  kind: GitignoreLayer['kind'] = 'gitignore',
): GitignoreLayer | null {
  try {
    // Backslashes in Git patterns are escapes, including on Windows.
    const content = readFileSync(fullPath, 'utf-8').normalize('NFD');
    const matcher = ignore().add(content);
    return {
      kind,
      sourcePath: fullPath,
      baseGitPath,
      content,
      matcher,
      directMatchers: new Map([['', matcher]]),
    };
  } catch (cause) {
    if (
      cause &&
      typeof cause === 'object' &&
      'code' in cause &&
      (cause.code === 'ENOENT' || cause.code === 'ENOTDIR')
    )
      return null;
    const code =
      cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string'
        ? ` (${cause.code})`
        : '';
    throw new Error('Cannot read Git ignore rules: ' + fullPath + code, { cause });
  }
}

function toGitPath(vaultPrefix: string, relativePath: string): string {
  return vaultPrefix ? vaultPrefix + (relativePath ? '/' + relativePath : '') : relativePath;
}

function scopedChildDirectories(dir: string, names: ReadonlySet<string>): string[] {
  const children = new Set<string>();
  let entries: Dirent[] | undefined;
  for (const name of names) {
    try {
      // Preserve the caller's physical spelling and do not follow directory symlinks.
      if (lstatSync(path.join(dir, name)).isDirectory()) children.add(name);
      continue;
    } catch (error) {
      if (
        !error ||
        typeof error !== 'object' ||
        !('code' in error) ||
        (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')
      )
        throw error;
    }
    // Database callers may only know an NFD identity. Resolve that identity in
    // this parent once, without enumerating siblings during ordinary updates.
    entries ??= readdirSync(dir, { withFileTypes: true, encoding: 'utf-8' });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.normalize('NFD') === name.normalize('NFD'))
        children.add(entry.name);
    }
  }
  return [...children];
}

function loadGitignoreLayers(
  vaultPath: string,
  operationalExcludes: Ignore,
  explicitExcludes: ExplicitMatcher,
  includePatterns: readonly string[],
  respectGitignore: boolean,
  context: GitContext | undefined,
  scopedAncestors?: ScopedAncestors,
): GitignoreLayer[] {
  if (!respectGitignore) return [];
  const layers: GitignoreLayer[] = [];
  const vaultPrefix = context?.vaultPrefix ?? '';
  if (context) {
    const exclude = readGitignoreLayer(context.excludePath, '', 'exclude');
    if (exclude) layers.push(exclude);
    for (const file of context.ancestorGitignorePaths) {
      const base = normalizeRelPath(path.relative(context.worktreePath, path.dirname(file)));
      if (base && gitignoreIgnores(layers, base + '/') && includePatterns.length === 0)
        return layers;
      const layer = readGitignoreLayer(file, base);
      if (layer) layers.push(layer);
    }
    if (vaultPrefix && gitignoreIgnores(layers, vaultPrefix + '/') && includePatterns.length === 0)
      return layers;
  }

  const walk = (
    dir: string,
    baseRelPath: string,
    inheritedLayers: readonly GitignoreLayer[],
  ): void => {
    const layer = readGitignoreLayer(
      path.join(dir, '.gitignore'),
      toGitPath(vaultPrefix, baseRelPath),
    );
    const activeLayers = layer ? [...inheritedLayers, layer] : inheritedLayers;
    if (layer) layers.push(layer);

    let childNames: string[];
    if (scopedAncestors) {
      const names = scopedAncestors.get(baseRelPath);
      if (!names) return;
      childNames = scopedChildDirectories(dir, names);
    } else {
      try {
        childNames = readdirSync(dir, { withFileTypes: true, encoding: 'utf-8' })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch {
        return;
      }
    }
    for (const name of childNames) {
      const childRelPath = normalizeRelPath(baseRelPath ? baseRelPath + '/' + name : name);
      const childDirPath = childRelPath + '/';
      if (matcherIgnores(operationalExcludes, childDirPath)) continue;
      if (explicitExcludes.ignores(childDirPath)) continue;
      if (
        gitignoreIgnores(activeLayers, toGitPath(vaultPrefix, childDirPath)) &&
        !includeMayMatchDescendant(childDirPath, includePatterns)
      )
        continue;
      walk(path.join(dir, name), childRelPath, activeLayers);
    }
  };
  walk(vaultPath, '', [...layers]);
  return layers;
}

// The combined layers have already resolved every proper ancestor as accessible.
// Neutralize stale inheritance inside this layer without rescuing the target itself.
function testGitignoreLayer(layer: GitignoreLayer, layerPath: string): ReturnType<Ignore['test']> {
  const parts = stripTrailingSlashes(layerPath).split('/');
  const parents = parts.slice(0, -1);
  const parentPath = parents.join('/');
  let matcher = layer.directMatchers.get(parentPath);
  if (!matcher) {
    matcher = ignore().add(layer.matcher);
    for (let i = 0; i < parents.length; i++) {
      const literal = parents
        .slice(0, i + 1)
        .join('/')
        .replace(/[\\*?[\]]/g, '\\$&');
      // The object overload preserves literal LF in a physical directory name.
      matcher.add({ pattern: `!/${literal}/` });
    }
    layer.directMatchers.set(parentPath, matcher);
  }
  return matcher.test(layerPath);
}

function gitignoreIgnores(layers: readonly GitignoreLayer[], relPath: string): boolean {
  const normalized = normalizeRelPath(relPath);
  const target = stripTrailingSlashes(normalized);
  if (!target || layers.length === 0) return false;
  const parts = target.split('/');
  for (let i = 0; i < parts.length; i++) {
    const directory = i < parts.length - 1 || normalized.endsWith('/');
    const current = parts.slice(0, i + 1).join('/') + (directory ? '/' : '');
    let ignored = false;
    for (const layer of layers) {
      const layerPath = toLayerRelativePath(current, layer.baseGitPath);
      if (layerPath === null || !layerPath) continue;
      const result = testGitignoreLayer(layer, layerPath);
      if (result.ignored) ignored = true;
      else if (result.unignored) ignored = false;
    }
    if (ignored) return true;
  }
  return false;
}

function sortedPatterns(patterns: readonly string[]): string[] {
  return patterns
    .map(normalizePattern)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

function includeMayMatchDescendant(
  relDirPath: string,
  includePatterns: readonly string[],
): boolean {
  const dir = stripTrailingSlashes(normalizeRelPath(relDirPath));
  if (!dir) return includePatterns.length > 0;
  const prefix = dir + '/';
  return includePatterns.some((pattern) => {
    const normalized = stripLeadingSlashes(normalizePattern(pattern));
    if (!normalized) return false;
    if (normalized === dir || normalized.startsWith(prefix)) return true;
    const wildcardAt = normalized.search(/[*?[\\]/);
    if (wildcardAt === -1) return false;
    const literalPrefix = normalized.slice(0, wildcardAt);
    return (
      literalPrefix === '' || literalPrefix.startsWith(prefix) || prefix.startsWith(literalPrefix)
    );
  });
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
  return value.slice(0, end);
}

function stripLeadingSlashes(value: string): string {
  let start = 0;
  while (start < value.length && value.charCodeAt(start) === 47) start++;
  return value.slice(start);
}

export function createIgnorePolicy(
  options: {
    vaultPath?: string;
    ignorePatterns?: readonly string[];
    includePatterns?: readonly string[];
    respectGitignore?: boolean;
  } = {},
): IgnorePolicy {
  const policy = createPolicyComponents(options);
  const { ignorePatterns, includePatterns, respectGitignore, gitignoreLayers, context } = policy;

  return {
    isIgnored: policy.isIgnored,
    controlWatchFiles: policy.controlWatchFiles,
    signature(): string {
      return JSON.stringify({
        matcherVersion: IGNORE_MATCHER_VERSION,
        operationalPatterns: sortedPatterns(OPERATIONAL_IGNORE_PATTERNS),
        ignorePatterns: sortedPatterns(ignorePatterns),
        includePatterns: sortedPatterns(includePatterns),
        respectGitignore,
        gitContext: context
          ? {
              worktreePath: context.worktreePath,
              gitDirPath: context.gitDirPath,
              commonDirPath: context.commonDirPath,
              vaultPrefix: context.vaultPrefix,
              excludePath: context.excludePath,
              excludeContent:
                gitignoreLayers.find((layer) => layer.kind === 'exclude')?.content ?? null,
            }
          : null,
        gitignoreFiles: gitignoreLayers
          .map((layer) => ({
            path: layer.sourcePath,
            kind: layer.kind,
            baseGitPath: layer.baseGitPath,
            content: layer.content,
          }))
          .sort((a, b) => a.path.localeCompare(b.path)),
      });
    },
  };
}

function createPolicyComponents(
  options: NonNullable<Parameters<typeof createIgnorePolicy>[0]>,
  scopedAncestors?: ScopedAncestors,
) {
  const vaultPath = options.vaultPath ?? config.vaultPath;
  const ignorePatterns = options.ignorePatterns ?? config.ignorePatterns;
  const includePatterns = options.includePatterns ?? config.includePatterns;
  const respectGitignore = options.respectGitignore ?? config.respectGitignore;
  const operationalExcludes = createMatcher(OPERATIONAL_IGNORE_PATTERNS);
  const explicitExcludes = createExplicitMatcher(ignorePatterns);
  const includes = createMatcher(includePatterns);
  const context = respectGitignore ? resolveGitContext(vaultPath) : undefined;
  const controlWatchFiles = context
    ? [
        ...new Set([
          context.excludePath,
          ...context.indirectionFiles,
          ...context.ancestorGitignorePaths,
        ]),
      ]
    : [];
  const gitignoreLayers = loadGitignoreLayers(
    vaultPath,
    operationalExcludes,
    explicitExcludes,
    includePatterns,
    respectGitignore,
    context,
    scopedAncestors,
  );

  return {
    isIgnored: (relPath: string): boolean => {
      const normalized = normalizeRelPath(relPath);
      if (!normalized) return false;
      if (matcherIgnores(operationalExcludes, normalized)) return true;
      if (explicitExcludes.ignores(normalized)) return true;
      const ignoredByGitignore = gitignoreIgnores(
        gitignoreLayers,
        toGitPath(context?.vaultPrefix ?? '', normalized),
      );
      if (!ignoredByGitignore) return false;
      if (normalized.endsWith('/') && includeMayMatchDescendant(normalized, includePatterns)) {
        return false;
      }
      return !matcherIgnores(includes, normalized);
    },
    ignorePatterns,
    includePatterns,
    respectGitignore,
    gitignoreLayers,
    context,
    controlWatchFiles,
  };
}

function fileAncestorPaths(relativePaths: readonly string[]): ScopedAncestors | undefined {
  const ancestors = new Map<string, Set<string>>();
  for (const relativePath of relativePaths) {
    const normalized = normalizeRelPath(relativePath);
    if (
      !normalized ||
      path.isAbsolute(relativePath) ||
      path.win32.isAbsolute(relativePath) ||
      normalized.split('/').some((part) => !part || part === '.' || part === '..')
    ) {
      return undefined;
    }
    const parts = relativePath
      .replaceAll(path.sep, '/')
      .replace(/^\.\/+/, '')
      .split('/');
    for (const [index, name] of parts.slice(0, -1).entries()) {
      const parent = parts.slice(0, index).join('/').normalize('NFD');
      const children = ancestors.get(parent) ?? new Set<string>();
      children.add(name);
      ancestors.set(parent, children);
    }
  }
  return ancestors;
}

export function createIgnorePolicyForFiles(
  relativePaths: readonly string[],
): Pick<IgnorePolicy, 'isIgnored'> {
  const components = createPolicyComponents({}, fileAncestorPaths(relativePaths));
  return { isIgnored: components.isIgnored };
}

export function isIgnored(relPath: string): boolean {
  return createIgnorePolicy().isIgnored(relPath);
}

export function getIgnoreSignature(): string {
  return createIgnorePolicy().signature();
}
