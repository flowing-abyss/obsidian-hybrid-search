import { activeModelName, getContextLength } from '../inference/embedder.js';
import { config } from '../runtime/config.js';
import {
  assertChunkPolicyCanInitialize,
  ChunkPolicyError,
  getStoredChunkPolicy,
  getStoredModel,
  initializeChunkPolicy,
  type ChunkPolicy,
} from '../storage/db.js';
import type { IndexRunContext } from './indexer.js';

function contextFallback(stored: ChunkPolicy | null): number | undefined {
  const model = getStoredModel();
  return !model || model === activeModelName() ? stored?.contextLength : undefined;
}

/** Status remains readable even if the index needs an explicit repair. */
export async function getIndexContextLength(): Promise<number> {
  let stored: ChunkPolicy | null = null;
  try {
    stored = getStoredChunkPolicy();
  } catch (error) {
    if (!(error instanceof ChunkPolicyError)) throw error;
  }
  return getContextLength(contextFallback(stored));
}

export function getChunkPolicyStatus(contextLength: number): {
  chunkTokens: number | null;
  notice?: string;
} {
  let stored: ChunkPolicy | null;
  try {
    stored = getStoredChunkPolicy();
    if (!stored) assertChunkPolicyCanInitialize();
  } catch (error) {
    if (!(error instanceof ChunkPolicyError)) throw error;
    return { chunkTokens: null, notice: error.message };
  }
  const chunkTokens = stored?.chunkTokens ?? null;
  let requested: number | undefined;
  try {
    requested = config.chunkTokens;
  } catch (error) {
    return { chunkTokens, notice: (error as Error).message };
  }
  if (chunkTokens !== null && chunkTokens > contextLength) {
    return { chunkTokens, notice: smallerModelLimitNotice(chunkTokens, contextLength) };
  }
  const target = requested === undefined ? chunkTokens : Math.min(requested, contextLength);
  return {
    chunkTokens,
    ...(chunkTokens !== null && target !== chunkTokens
      ? {
          notice: `Index uses ${chunkTokens}-token chunks. Run ohs reindex --force to apply ${target} from OBSIDIAN_CHUNK_TOKENS.`,
        }
      : {}),
  };
}

function smallerModelLimitNotice(chunkTokens: number, contextLength: number): string {
  return `Index chunk size ${chunkTokens} exceeds the model limit ${contextLength}. Existing index preserved; use full reindex --force to apply the smaller limit.`;
}

/** Resolve once per owner run. Only a deliberate full rebuild adopts env changes. */
export async function prepareChunkPolicy(
  run: IndexRunContext,
  force = false,
  initialChunkTokens?: number,
): Promise<ChunkPolicy> {
  if (!force && run.chunkPolicy) return run.chunkPolicy;
  let stored: ChunkPolicy | null;
  try {
    stored = getStoredChunkPolicy();
  } catch (error) {
    if (!force || !(error instanceof ChunkPolicyError)) throw error;
    stored = null;
  }
  if (!force && !stored) assertChunkPolicyCanInitialize();
  // A changed/invalid environment cannot interrupt updates using a valid index policy.
  const requested =
    !stored || force
      ? (config.chunkTokens ?? initialChunkTokens ?? stored?.chunkTokens ?? 512)
      : stored.chunkTokens;
  const contextLength = await getContextLength(contextFallback(stored));
  run.signal.throwIfAborted();
  if (!force && stored) {
    if (stored.chunkTokens > contextLength) {
      throw new ChunkPolicyError(smallerModelLimitNotice(stored.chunkTokens, contextLength));
    }
    run.chunkPolicy = stored;
  } else {
    const target = { chunkTokens: Math.min(requested, contextLength), contextLength };
    run.chunkPolicy = force ? target : initializeChunkPolicy(run.lease, target);
  }
  return run.chunkPolicy;
}
