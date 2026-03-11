import path from 'node:path';
import { config } from './config.js';

function matchesIgnorePattern(relPath: string, pattern: string): boolean {
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    return (
      relPath === prefix ||
      relPath.startsWith(prefix + path.sep) ||
      relPath.startsWith(prefix + '/')
    );
  }
  if (pattern.startsWith('*.')) {
    const ext = pattern.slice(1);
    return relPath.endsWith(ext) || path.basename(relPath).endsWith(ext);
  }
  return relPath === pattern || relPath.startsWith(pattern + '/');
}

export function isIgnored(relPath: string): boolean {
  return config.ignorePatterns.some((p) => matchesIgnorePattern(relPath, p.trim()));
}
