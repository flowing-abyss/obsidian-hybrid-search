/** Unicode storage identity; does not alter platform path separators. */
export function normalizeNotePath(path: string): string {
  return path.normalize('NFD');
}

export function normalizeTag(tag: string): string {
  return tag.normalize('NFD').toLowerCase();
}
