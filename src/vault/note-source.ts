import fs from 'node:fs';
import path from 'node:path';

interface NoteSourceReader {
  read(notePath: string): string | null;
}

function errorCode(error: unknown): string | undefined {
  return error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}

function isMissing(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function readError(notePath: string, cause: unknown): Error {
  return new Error(`Cannot read note ${notePath} (${errorCode(cause) ?? 'filesystem error'})`, {
    cause,
  });
}

function readFile(fullPath: string, notePath: string): string | null {
  try {
    return fs.readFileSync(fullPath, 'utf8');
  } catch (error) {
    if (isMissing(error)) return null;
    throw readError(notePath, error);
  }
}

/** Directory names are cached for one read batch, never note contents. */
export function createNoteSourceReader(vaultPath: string): NoteSourceReader {
  const directories = new Map<string, Map<string, string[]>>();

  const readNames = (directory: string, notePath: string): Map<string, string[]> | null => {
    const cached = directories.get(directory);
    if (cached) return cached;
    let names: string[];
    try {
      names = fs.readdirSync(directory);
    } catch (error) {
      if (isMissing(error)) return null;
      throw readError(notePath, error);
    }
    const normalized = new Map<string, string[]>();
    for (const name of names) {
      const key = name.normalize('NFD');
      const matches = normalized.get(key) ?? [];
      matches.push(name);
      normalized.set(key, matches);
    }
    directories.set(directory, normalized);
    return normalized;
  };

  const resolveSource = (notePath: string): string | null => {
    let directory = vaultPath;
    for (const component of notePath.split('/')) {
      const matches = readNames(directory, notePath)?.get(component.normalize('NFD'));
      if (!matches?.length) return null;
      if (matches.length > 1) {
        throw new Error(`Cannot read note ${notePath}: ambiguous normalized path`);
      }
      directory = path.join(directory, matches[0]!);
    }
    return directory;
  };

  return {
    read(notePath) {
      let raw = readFile(path.join(vaultPath, notePath), notePath);
      if (raw === null) {
        const resolved = resolveSource(notePath);
        if (resolved === null) return null;
        raw = readFile(resolved, notePath);
        if (raw === null) return null;
      }
      return raw;
    },
  };
}
