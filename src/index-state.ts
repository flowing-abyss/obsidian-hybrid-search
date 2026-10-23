// Local index generation complements the persisted cross-process database version.
let localVersion = 0;

export function getIndexVersion(): number {
  return localVersion;
}

/**
 * Increment the local (in-process) version so that subsequent searches bypass the
 * cache after indexing or watcher changes, and during test setup. Database versioning
 * separately invalidates cached results when another process changes the index.
 */
export function bumpIndexVersion(): void {
  localVersion++;
}
