import { config } from './config.js';
import { getStats } from './db.js';
import { activeModelName, useRemoteEmbeddings } from './embedder.js';
import { getIndexingStatus } from './indexer.js';

export interface StatusPayloadOptions {
  contextLength: number;
  version: string;
}

/**
 * The status report shared by the `status` command, the stdio IPC action and the
 * mcp tool, so every consumer sees the same field names.
 */
export function buildStatusPayload({
  contextLength,
  version,
}: StatusPayloadOptions): Record<string, unknown> {
  const stats = getStats();
  const indexingStatus = getIndexingStatus();

  return {
    total: stats.total,
    indexed: stats.indexed,
    // Notes with no body to embed — empty or frontmatter-only. They are still
    // indexed for title, tag and fulltext search, so this is not a failure.
    notes_without_chunks: stats.withoutChunks,
    pending: indexingStatus.queued,
    chunks: stats.chunks,
    // Chunks the embedding provider rejected. Unlike the above, this is a failure.
    failed_chunks: stats.failedChunks,
    links: stats.links,
    last_indexed: stats.lastIndexed,
    db_size_mb:
      stats.dbSizeBytes !== null ? Math.round((stats.dbSizeBytes / 1024 / 1024) * 10) / 10 : null,
    // Null in local mode: config.apiBaseUrl always holds the OpenAI default, so
    // reporting it unconditionally names an endpoint nothing is talking to.
    api_base_url: useRemoteEmbeddings() ? config.apiBaseUrl : null,
    // The model the index was built with.
    model: stats.embeddingModel,
    // The model this process would embed with now. The two differ whenever the
    // environment drifted from the index — the case that silently breaks search.
    active_model: activeModelName(),
    embedding_dim: stats.embeddingDim,
    context_length: contextLength,
    version,
    ignore_patterns: config.ignorePatterns,
    respect_gitignore: config.respectGitignore,
    include_patterns: config.includePatterns,
  };
}
