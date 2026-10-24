import { statSync } from 'node:fs';
import path from 'node:path';
import { normalizeNotePath } from '../content/text-normalization.js';
import { activeModelName, getEmbeddingDim, primeEmbeddingDim } from '../inference/embedder.js';
import { config } from '../runtime/config.js';
import { getStoredEmbeddingDim } from '../storage/db.js';
import { IndexLeaseLostError } from '../storage/index-ownership.js';
import {
  beginRebuild,
  discardRebuilds,
  publishRebuild,
  readRebuildNotes,
  removeRebuildNote,
  setRebuildReferences,
  stageRebuildNote,
} from '../storage/index-rebuild.js';
import { bumpIndexVersion } from '../storage/index-state.js';
import { createIgnorePolicy } from '../vault/ignore.js';
import type { IndexRunContext } from './index-owner.js';
import { retryIndexWrite } from './index-write.js';
import {
  createPreparedReferenceResolver,
  prepareIndexFile,
  scanVault,
  type IndexResult,
} from './indexer.js';

/** Build away from active rows, then publish the complete compatible snapshot. */
export async function rebuildIndex(
  run: IndexRunContext,
  contextLength: number,
): Promise<IndexResult> {
  const previousDimension = getStoredEmbeddingDim();
  let staged = false;
  try {
    const dimension = await getEmbeddingDim({ refresh: true, signal: run.signal });
    const id = beginRebuild(run.lease, {
      modelName: activeModelName(),
      embeddingDim: dimension,
      metadata: {
        vaultPath: config.vaultPath,
        apiBaseUrl: config.apiBaseUrl,
        apiModel: config.apiModel,
      },
    });
    staged = true;
    for (let pass = 0; pass < 3; pass++) {
      run.signal.throwIfAborted();
      const files = scanVault(run);
      const policy = createIgnorePolicy();
      const prior = new Map(readRebuildNotes(id).map((row) => [row.note.path, row]));
      const present = new Set<string>();
      for (let i = 0; i < files.length; i += config.batchSize) {
        await Promise.all(
          files.slice(i, i + config.batchSize).map(async (file) => {
            run.signal.throwIfAborted();
            const relative = normalizeNotePath(
              path.relative(config.vaultPath, file).split(path.sep).join('/'),
            );
            present.add(relative);
            const existing = prior.get(relative);
            let current;
            try {
              current = statSync(file);
            } catch {
              return;
            }
            if (existing && existing.mtime === current.mtimeMs && existing.size === current.size)
              return;
            const prepared = await prepareIndexFile(run, file, contextLength, policy, true);
            if (prepared.kind === 'prepared')
              stageRebuildNote(
                run.lease,
                id,
                prepared.note,
                prepared.frontmatterRaw,
                prepared.fingerprint,
              );
            else if (prepared.kind === 'missing') removeRebuildNote(run.lease, id, prepared.path);
          }),
        );
      }
      for (const relative of prior.keys())
        if (!present.has(relative)) removeRebuildNote(run.lease, id, relative);
      const rows = readRebuildNotes(id);
      const finalFiles = scanVault(run);
      const byPath = new Map(rows.map((row) => [row.note.path, row]));
      const stable =
        finalFiles.length === rows.length &&
        finalFiles.every((file) => {
          const relative = normalizeNotePath(
            path.relative(config.vaultPath, file).split(path.sep).join('/'),
          );
          const row = byPath.get(relative);
          try {
            const stat = statSync(file);
            return row && row.mtime === stat.mtimeMs && row.size === stat.size;
          } catch {
            return false;
          }
        });
      if (!stable) continue;
      const catalog = rows.map(({ note }) => ({
        path: note.path,
        title: note.title,
        aliases: JSON.stringify(note.aliases ?? []),
      }));
      const resolveReferences = createPreparedReferenceResolver(catalog);
      for (const row of rows)
        setRebuildReferences(
          run.lease,
          id,
          row.note.path,
          resolveReferences(row.note, row.frontmatterRaw),
        );
      await retryIndexWrite(run, () => publishRebuild(run.lease, id));
      staged = false;
      bumpIndexVersion();
      process.stderr.write(`Done. ${rows.length} notes indexed.\n`);
      return { indexed: rows.length, skipped: 0, errors: [] };
    }
    throw new Error(
      'The vault kept changing during reindex; existing index preserved. Retry after the edits settle.',
    );
  } finally {
    if (staged && !run.signal.aborted) {
      // A stale owner's cleanup is fenced just like publication.
      try {
        discardRebuilds(run.lease);
      } catch (error) {
        if (!(error instanceof IndexLeaseLostError))
          console.error('[indexer] could not clean abandoned rebuild:', error);
      }
    }
    if (!run.signal.aborted) {
      const active = getStoredEmbeddingDim() ?? previousDimension;
      if (active !== null) primeEmbeddingDim(active);
    }
  }
}
