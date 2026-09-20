import ignore, { type Ignore } from 'ignore';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const OPERATIONAL_IGNORE_PATTERNS = ['.obsidian/**', '.obsidian-hybrid-search.db*'];
// Bump when explicit-pattern matching changes. Notes that only the new matcher ignores
// are then swept as newly ignored (links kept) rather than as files deleted from disk.
const IGNORE_MATCHER_VERSION = 2;

interface GitignoreLayer {
  baseRelPath: string;
  content: string;
  matcher: Ignore;
}

interface ExplicitMatcher {
  ignores(relPath: string): boolean;
}

export interface IgnorePolicy {
  isIgnored(relPath: string): boolean;
  signature(): string;
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

function readGitignoreLayer(dir: string, baseRelPath: string): GitignoreLayer | null {
  const fullPath = path.join(dir, '.gitignore');
  if (!existsSync(fullPath)) return null;
  try {
    const content = readFileSync(fullPath, 'utf-8').replaceAll(path.sep, '/').normalize('NFD');
    return {
      baseRelPath,
      content,
      matcher: ignore().add(content),
    };
  } catch {
    return null;
  }
}

function loadGitignoreLayers(
  vaultPath: string,
  operationalExcludes: Ignore,
  explicitExcludes: ExplicitMatcher,
  includePatterns: readonly string[],
  respectGitignore: boolean,
): GitignoreLayer[] {
  if (!respectGitignore) return [];
  const layers: GitignoreLayer[] = [];

  const walk = (
    dir: string,
    baseRelPath: string,
    inheritedLayers: readonly GitignoreLayer[],
  ): void => {
    const layer = readGitignoreLayer(dir, baseRelPath);
    const activeLayers = layer ? [...inheritedLayers, layer] : inheritedLayers;
    if (layer) layers.push(layer);

    let entries: { name: string; isDirectory(): boolean }[];
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf-8' });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const childRelPath = normalizeRelPath(
        baseRelPath ? `${baseRelPath}/${entry.name}` : entry.name,
      );
      const childDirPath = childRelPath + '/';
      if (matcherIgnores(operationalExcludes, childDirPath)) continue;
      if (explicitExcludes.ignores(childDirPath)) continue;
      if (
        gitignoreIgnores(activeLayers, childDirPath) &&
        !includeMayMatchDescendant(childDirPath, includePatterns)
      ) {
        continue;
      }
      walk(path.join(dir, entry.name), childRelPath, activeLayers);
    }
  };

  walk(vaultPath, '', []);
  return layers;
}

function gitignoreIgnores(layers: readonly GitignoreLayer[], relPath: string): boolean {
  let ignored = false;
  for (const layer of layers) {
    const layerPath = toLayerRelativePath(relPath, layer.baseRelPath);
    if (layerPath === null || !layerPath) continue;
    const result = layer.matcher.test(normalizeRelPath(layerPath));
    if (matcherIgnores(layer.matcher, layerPath)) {
      ignored = true;
    } else if (result.unignored) {
      ignored = false;
    }
  }
  return ignored;
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
  const vaultPath = options.vaultPath ?? config.vaultPath;
  const ignorePatterns = options.ignorePatterns ?? config.ignorePatterns;
  const includePatterns = options.includePatterns ?? config.includePatterns;
  const respectGitignore = options.respectGitignore ?? config.respectGitignore;
  const operationalExcludes = createMatcher(OPERATIONAL_IGNORE_PATTERNS);
  const explicitExcludes = createExplicitMatcher(ignorePatterns);
  const includes = createMatcher(includePatterns);
  const gitignoreLayers = loadGitignoreLayers(
    vaultPath,
    operationalExcludes,
    explicitExcludes,
    includePatterns,
    respectGitignore,
  );

  return {
    isIgnored(relPath: string): boolean {
      const normalized = normalizeRelPath(relPath);
      if (matcherIgnores(operationalExcludes, normalized)) return true;
      if (explicitExcludes.ignores(normalized)) return true;
      const ignoredByGitignore = gitignoreIgnores(gitignoreLayers, normalized);
      if (!ignoredByGitignore) return false;
      if (normalized.endsWith('/') && includeMayMatchDescendant(normalized, includePatterns)) {
        return false;
      }
      return !matcherIgnores(includes, normalized);
    },
    signature(): string {
      return JSON.stringify({
        matcherVersion: IGNORE_MATCHER_VERSION,
        operationalPatterns: sortedPatterns(OPERATIONAL_IGNORE_PATTERNS),
        ignorePatterns: sortedPatterns(ignorePatterns),
        includePatterns: sortedPatterns(includePatterns),
        respectGitignore,
        gitignoreFiles: gitignoreLayers
          .map((layer) => ({
            path: layer.baseRelPath ? `${layer.baseRelPath}/.gitignore` : '.gitignore',
            content: layer.content,
          }))
          .sort((a, b) => a.path.localeCompare(b.path)),
      });
    },
  };
}

export function isIgnored(relPath: string): boolean {
  return createIgnorePolicy().isIgnored(relPath);
}

export function getIgnoreSignature(): string {
  return createIgnorePolicy().signature();
}
