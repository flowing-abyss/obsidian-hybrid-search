import os from 'node:os';
import path from 'node:path';

/** Machine-local state shared by CLI and MCP, outside any vault. */
export function getLocalStateDirectory(): string {
  return path.join(
    process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'),
    'obsidian-hybrid-search',
  );
}
