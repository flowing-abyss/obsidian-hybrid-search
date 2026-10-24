import { readFileSync, realpathSync, statSync, type Stats } from 'node:fs';
import path from 'node:path';

export interface GitContext {
  readonly worktreePath: string;
  readonly gitDirPath: string;
  readonly commonDirPath: string;
  readonly vaultPrefix: string;
  readonly excludePath: string;
  readonly indirectionFiles: readonly string[];
  readonly ancestorGitignorePaths: readonly string[];
}

function optionalStat(file: string): Stats | undefined {
  try {
    return statSync(file);
  } catch (cause) {
    if (
      cause &&
      typeof cause === 'object' &&
      'code' in cause &&
      (cause.code === 'ENOENT' || cause.code === 'ENOTDIR')
    )
      return undefined;
    throw new Error('Cannot read Git metadata: ' + file, { cause });
  }
}

function readPointer(file: string, stats: Stats): string {
  if (!stats.isFile() || stats.size > 1024 * 1024)
    throw new Error('Invalid Git metadata pointer: ' + file);
  try {
    const content = readFileSync(file, 'utf8');
    let end = content.length;
    while (end > 0 && (content[end - 1] === '\r' || content[end - 1] === '\n')) end--;
    const value = content.slice(0, end);
    if (!value || value.includes('\0')) throw new Error('Empty or invalid pointer');
    return value;
  } catch (cause) {
    throw new Error('Cannot read Git metadata pointer: ' + file, { cause });
  }
}

function resolveDirectory(base: string, target: string, source: string): string {
  try {
    const resolved = realpathSync(path.resolve(base, target));
    if (!statSync(resolved).isDirectory()) throw new Error('Target is not a directory');
    return resolved;
  } catch (cause) {
    throw new Error('Cannot resolve Git metadata pointer: ' + source, { cause });
  }
}

/** Discover the configured vault's containing working tree without a Git subprocess. */
export function resolveGitContext(vaultPath: string): GitContext | undefined {
  if (!optionalStat(vaultPath)) return undefined;
  const physicalVault = realpathSync(vaultPath);
  for (let directory = physicalVault; ; directory = path.dirname(directory)) {
    const marker = path.join(directory, '.git');
    const stats = optionalStat(marker);
    if (stats) {
      const indirectionFiles: string[] = [];
      let gitDirPath: string;
      if (stats.isDirectory()) {
        gitDirPath = realpathSync(marker);
      } else {
        const pointer = readPointer(marker, stats);
        if (!pointer.startsWith('gitdir: ') || pointer.length === 8)
          throw new Error('Invalid Git metadata pointer: ' + marker);
        gitDirPath = resolveDirectory(directory, pointer.slice(8), marker);
        indirectionFiles.push(marker);
      }
      const commonPointer = path.join(gitDirPath, 'commondir');
      indirectionFiles.push(commonPointer);
      const commonStats = optionalStat(commonPointer);
      const commonDirPath = commonStats
        ? resolveDirectory(gitDirPath, readPointer(commonPointer, commonStats), commonPointer)
        : gitDirPath;
      const ancestorGitignorePaths: string[] = [];
      if (physicalVault !== directory) {
        for (let ancestor = path.dirname(physicalVault); ; ancestor = path.dirname(ancestor)) {
          ancestorGitignorePaths.unshift(path.join(ancestor, '.gitignore'));
          if (ancestor === directory) break;
        }
      }
      return {
        worktreePath: directory,
        gitDirPath,
        commonDirPath,
        vaultPrefix: path
          .relative(directory, physicalVault)
          .split(path.sep)
          .join('/')
          .normalize('NFD'),
        excludePath: path.join(commonDirPath, 'info', 'exclude'),
        indirectionFiles,
        ancestorGitignorePaths,
      };
    }
    if (directory === path.dirname(directory)) return undefined;
  }
}
