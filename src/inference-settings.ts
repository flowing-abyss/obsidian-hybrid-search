import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getLocalStateDirectory } from './local-state.js';

export const MAX_CPU_THREADS = 2147483647;
const FILE_NAME = 'inference-settings.json';

let loaded = false;
let threads = 0;

function validThreads(value: unknown): value is number {
  return (
    Number.isInteger(value) && typeof value === 'number' && value >= 0 && value <= MAX_CPU_THREADS
  );
}

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const state: unknown = JSON.parse(
      fs.readFileSync(path.join(getLocalStateDirectory(), FILE_NAME), 'utf8'),
    );
    if (
      typeof state !== 'object' ||
      state === null ||
      Array.isArray(state) ||
      Object.keys(state).length !== 2 ||
      !('version' in state) ||
      state.version !== 1 ||
      !('threads' in state) ||
      !validThreads(state.threads)
    ) {
      throw new Error('invalid schema');
    }
    threads = state.threads;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    process.stderr.write(
      '[warn] Invalid or unreadable local inference settings; using native CPU auto.\n',
    );
  }
}

export function getCpuSessionOptions(): { intraOpNumThreads: number } | undefined {
  load();
  return threads > 0 ? { intraOpNumThreads: threads } : undefined;
}

export function saveCpuThreads(value: number): void {
  if (!validThreads(value)) {
    throw new Error(`Invalid --threads: expected integer from 0 to ${MAX_CPU_THREADS}`);
  }
  const directory = getLocalStateDirectory();
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, FILE_NAME);
  const temporary = path.join(directory, `${FILE_NAME}.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, threads: value }), {
      flag: 'wx',
      mode: 0o600,
    });
    fs.renameSync(temporary, target);
    threads = value;
    loaded = true;
  } finally {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Preserve the original write or rename failure.
    }
  }
}
