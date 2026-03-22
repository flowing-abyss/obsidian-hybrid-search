import type { Llama, LlamaEmbeddingContext, LlamaRankingContext } from 'node-llama-cpp';
import os from 'node:os';
import path from 'node:path';

import { config } from './config.js';
import type { RerankCandidate } from './reranker-types.js';

// Spike findings (validated 2026-03-23):
// - resolveModelFile(hfUri, dir) downloads & caches → returns local path
// - loadModel({ modelPath }) loads the GGUF
// - createEmbeddingContext() → getEmbeddingFor(text) → { vector: readonly number[] } (1024-dim for BGE-M3)
// - createRankingContext() → rank(query, doc) → number 0-1 (probability, sigmoid applied)
// - rankAll(query, docs[]) → number[] (batch scoring)
// - GGUF repos: gpustack org, not BAAI org

// ── Constants ─────────────────────────────────────────────────────────────────
const EMBED_MODEL_URI = 'hf:gpustack/bge-m3-GGUF/bge-m3-Q4_K_M.gguf';

// BGE-M3 via llama.cpp returns mean-pooled but un-normalized embeddings.
// sqlite-vec uses L2 distance which is equivalent to cosine distance only when
// vectors are unit-normalized.  Normalize here so retrieval ranking is correct.
function l2Normalize(vec: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) sumSq += vec[i]! * vec[i]!;
  const norm = Math.sqrt(sumSq);
  if (norm === 0) return vec; // zero vector — leave as-is
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i]! / norm;
  return out;
}
const RERANKER_MODEL_URI = 'hf:gpustack/bge-reranker-v2-m3-GGUF/bge-reranker-v2-m3-Q4_K_M.gguf';

function getModelsDir(): string {
  return path.join(os.homedir(), '.cache', 'obsidian-hybrid-search', 'models');
}

// ── Singleton Llama instance ──────────────────────────────────────────────────
let llamaInstance: Llama | null = null;
let llamaPromise: Promise<Llama> | null = null;

async function getLlamaInstance(): Promise<Llama> {
  if (llamaInstance) return llamaInstance;
  if (!llamaPromise) {
    llamaPromise = (async () => {
      try {
        // Dynamic import so vi.mock('node-llama-cpp') intercepts correctly
        // even with isolate:false in vitest config.
        const { getLlama } = await import('node-llama-cpp');
        const l = await getLlama();
        llamaInstance = l;
        return l;
      } catch (err) {
        llamaPromise = null; // allow retry on transient failure
        throw err;
      }
    })();
  }
  return llamaPromise;
}

// ── Embedding model (BGE-M3) ──────────────────────────────────────────────────
let embedCtx: LlamaEmbeddingContext | null = null;
let embedLoadPromise: Promise<void> | null = null;

async function getEmbedContext(): Promise<LlamaEmbeddingContext> {
  if (embedCtx) return embedCtx;
  if (!embedLoadPromise) {
    embedLoadPromise = (async () => {
      try {
        const { resolveModelFile } = await import('node-llama-cpp');
        const llama = await getLlamaInstance();
        const modelPath = await resolveModelFile(EMBED_MODEL_URI, getModelsDir());
        const model = await llama.loadModel({ modelPath });
        embedCtx = await model.createEmbeddingContext();
      } catch (err) {
        embedLoadPromise = null; // allow retry on transient failure
        throw err;
      }
    })();
  }
  await embedLoadPromise;
  if (!embedCtx) throw new Error('[llama-backend] embedding context failed to initialize');
  return embedCtx;
}

// ── Reranker model (BGE-reranker-v2-m3) ──────────────────────────────────────
let rerankerCtx: LlamaRankingContext | null = null;
let rerankerLoadPromise: Promise<void> | null = null;

async function getRerankerContext(): Promise<LlamaRankingContext> {
  if (rerankerCtx) return rerankerCtx;
  if (!rerankerLoadPromise) {
    rerankerLoadPromise = (async () => {
      try {
        const { resolveModelFile } = await import('node-llama-cpp');
        const llama = await getLlamaInstance();
        const modelPath = await resolveModelFile(RERANKER_MODEL_URI, getModelsDir());
        const model = await llama.loadModel({ modelPath });
        rerankerCtx = await model.createRankingContext();
      } catch (err) {
        rerankerLoadPromise = null; // allow retry on transient failure
        throw err;
      }
    })();
  }
  await rerankerLoadPromise;
  if (!rerankerCtx) throw new Error('[llama-backend] reranker context failed to initialize');
  return rerankerCtx;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Reset all module-level singletons.
 * ONLY for use in tests — allows beforeEach to start each test with a clean state.
 */
export function _resetForTest(): void {
  llamaInstance = null;
  llamaPromise = null;
  embedCtx = null;
  embedLoadPromise = null;
  rerankerCtx = null;
  rerankerLoadPromise = null;
}

export async function llamaEmbed(
  texts: string[],
  type: 'query' | 'document',
): Promise<(Float32Array | null)[]> {
  // BGE-M3 uses E5-style "query:"/"passage:" prefixes for asymmetric retrieval.
  // Spike eval: with-prefix improves nDCG@5 by ~20% vs no-prefix on the
  // Obsidian help benchmark (0.620 vs 0.474). Keep prefixes.
  const prefix = type === 'query' ? 'query: ' : 'passage: ';
  const ctx = await getEmbedContext();
  const results: (Float32Array | null)[] = [];

  for (let i = 0; i < texts.length; i += config.batchSize) {
    const batch = texts.slice(i, i + config.batchSize);
    const batchResults = await Promise.all(
      batch.map(async (text) => {
        try {
          const embedding = await ctx.getEmbeddingFor(prefix + text);
          return l2Normalize(new Float32Array(embedding.vector));
        } catch (err) {
          process.stderr.write(
            `[llama-backend] embedding failed for text snippet: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          return null;
        }
      }),
    );
    results.push(...batchResults);
  }

  return results;
}

export async function llamaRerank(query: string, candidates: RerankCandidate[]): Promise<number[]> {
  if (candidates.length === 0) return [];
  const ctx = await getRerankerContext();
  const docs = candidates.map((c) => `${c.title}\n\n${c.chunkText ?? c.snippet}`);
  try {
    return await ctx.rankAll(query, docs);
  } catch (err) {
    process.stderr.write(
      `[llama-backend] reranking failed: ${err instanceof Error ? err.message : String(err)}. Returning zeros.\n`,
    );
    return candidates.map(() => 0);
  }
}
