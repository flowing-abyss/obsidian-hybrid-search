import ignore, { type Ignore } from 'ignore';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const OPERATIONAL_IGNORE_PATTERNS = ['.obsidian/**', '.obsidian-hybrid-search.db*'];
const DIRECTORY_SENTINEL = '__obsidian_hybrid_search_directory_probe__.md';

interface GitignoreLayer {
  baseRelPath: string;
  content: string;
  matcher: Ignore;
}

interface LegacyMatcher {
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

function createLegacyMatcher(patterns: readonly string[]): LegacyMatcher {
  const normalized = patterns.map(normalizePattern).filter(Boolean);
  return {
    ignores(relPath: string): boolean {
      return normalized.some((pattern) => matchesLegacyIgnorePattern(relPath, pattern));
    },
  };
}

function createMatcher(patterns: readonly string[]): Ignore {
  const matcher = ignore();
  const normalized = patterns.map(normalizePattern).filter(Boolean);
  if (normalized.length > 0) matcher.add(normalized);
  return matcher;
}

function matcherIgnores(matcher: Ignore | LegacyMatcher, relPath: string): boolean {
  const normalized = normalizeRelPath(relPath);
  if (!normalized) return false;
  if (matcher.ignores(normalized)) return true;
  if (normalized.endsWith('/')) return matcher.ignores(normalized + DIRECTORY_SENTINEL);
  return false;
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
  operationalExcludes: Ignore | LegacyMatcher,
  explicitExcludes: Ignore | LegacyMatcher,
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
      if (matcherIgnores(explicitExcludes, childRelPath + '/')) continue;
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
  const dir = normalizeRelPath(relDirPath).replace(/\/+$/, '');
  if (!dir) return includePatterns.length > 0;
  const prefix = dir + '/';
  return includePatterns.some((pattern) => {
    const normalized = normalizePattern(pattern).replace(/^\/+/, '');
    if (!normalized) return false;
    if (normalized === dir || normalized.startsWith(prefix)) return true;
    if (normalized.includes('*')) {
      const literalPrefix = normalized.split('*', 1)[0] ?? '';
      return (
        literalPrefix === '' || literalPrefix.startsWith(prefix) || prefix.startsWith(literalPrefix)
      );
    }
    return false;
  });
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
  const explicitExcludes = createLegacyMatcher(ignorePatterns);
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
      if (matcherIgnores(explicitExcludes, normalized)) return true;
      const ignoredByGitignore = gitignoreIgnores(gitignoreLayers, normalized);
      if (!ignoredByGitignore) return false;
      if (normalized.endsWith('/') && includeMayMatchDescendant(normalized, includePatterns)) {
        return false;
      }
      return !matcherIgnores(includes, normalized);
    },
    signature(): string {
      return JSON.stringify({
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
