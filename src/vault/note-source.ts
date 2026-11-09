import fs from 'node:fs';
import path from 'node:path';

interface NoteSourceReader {
  read(notePath: string): string | null;
  readWithStat(notePath: string): Promise<{ raw: string; stat: fs.Stats } | null>;
  stat(notePath: string): fs.Stats | null;
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

function pathComponents(notePath: string): string[] {
  const components = notePath.split(path.sep).join('/').split('/');
  if (path.isAbsolute(notePath) || notePath.includes('\0') || components.includes('..')) {
    throw new Error(`Cannot read note ${notePath}: expected a vault-relative path`);
  }
  const meaningful = components.filter((part) => part !== '' && part !== '.');
  if (!meaningful.length)
    throw new Error(`Cannot read note ${notePath}: expected a vault-relative file path`);
  return meaningful;
}

/** Directory names are cached for one read batch, never note contents. */
export function createNoteSourceReader(vaultPath: string): NoteSourceReader {
  // A symlink selecting the vault is supported; paths beneath that root cannot
  // follow links. Explicit reads and single-file indexing must match scanner rules.
  const root = fs.realpathSync(vaultPath);
  const directories = new Map<string, Map<string, string[]>>();

  const assertContained = (fullPath: string, notePath: string): void => {
    const canonical = fs.realpathSync(fullPath);
    const relative = path.relative(root, canonical);
    if (
      !relative ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(`Cannot read note ${notePath}: path escapes the vault`);
    }
  };

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

  const resolveSource = (notePath: string): { fullPath: string; stat: fs.Stats } | null => {
    const components = pathComponents(notePath);
    let directory = root;
    let stat: fs.Stats | undefined;
    for (const [index, component] of components.entries()) {
      let fullPath = path.join(directory, component);
      try {
        stat = fs.lstatSync(fullPath);
      } catch (error) {
        if (!isMissing(error)) throw readError(notePath, error);
        const matches = readNames(directory, notePath)?.get(component.normalize('NFD'));
        if (!matches?.length) return null;
        if (matches.length > 1) {
          throw new Error(`Cannot read note ${notePath}: ambiguous normalized path`, {
            cause: error,
          });
        }
        fullPath = path.join(directory, matches[0]!);
        try {
          stat = fs.lstatSync(fullPath);
        } catch (fallbackError) {
          if (isMissing(fallbackError)) return null;
          throw readError(notePath, fallbackError);
        }
      }
      if (stat.isSymbolicLink())
        throw new Error(`Cannot read note ${notePath}: symbolic links are not allowed`);
      if (index < components.length - 1 && !stat.isDirectory()) return null;
      directory = fullPath;
    }
    if (!stat?.isFile()) throw new Error(`Cannot read note ${notePath}: expected a regular file`);
    try {
      assertContained(directory, notePath);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    return { fullPath: directory, stat };
  };

  const openSource = (notePath: string): { fd: number; stat: fs.Stats } | null => {
    const source = resolveSource(notePath);
    if (!source) return null;
    let fd: number;
    try {
      // The descriptor pins the checked file during asynchronous reads. O_NONBLOCK
      // prevents a file swapped for a FIFO from hanging before fstat can reject it.
      fd = fs.openSync(
        source.fullPath,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0),
      );
    } catch (error) {
      if (isMissing(error)) return null;
      throw readError(notePath, error);
    }
    try {
      const stat = fs.fstatSync(fd);
      assertContained(source.fullPath, notePath);
      if (!stat.isFile() || stat.dev !== source.stat.dev || stat.ino !== source.stat.ino) {
        throw new Error(`Cannot read note ${notePath}: source changed while opening`);
      }
      return { fd, stat };
    } catch (error) {
      fs.closeSync(fd);
      if (isMissing(error)) return null;
      throw error;
    }
  };

  return {
    read(notePath) {
      const source = openSource(notePath);
      if (!source) return null;
      try {
        return fs.readFileSync(source.fd, 'utf8');
      } catch (error) {
        throw readError(notePath, error);
      } finally {
        fs.closeSync(source.fd);
      }
    },
    async readWithStat(notePath) {
      const source = openSource(notePath);
      if (!source) return null;
      try {
        const raw = await new Promise<string>((resolve, reject) => {
          fs.readFile(source.fd, 'utf8', (error, content) => {
            if (error) reject(readError(notePath, error));
            else resolve(content);
          });
        });
        return { raw, stat: source.stat };
      } finally {
        fs.closeSync(source.fd);
      }
    },
    stat(notePath) {
      return resolveSource(notePath)?.stat ?? null;
    },
  };
}
