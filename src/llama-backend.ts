import type { Llama, LlamaEmbeddingContext, LlamaRankingContext } from 'node-llama-cpp';
import { getLlama, resolveModelFile } from 'node-llama-cpp';
import os from 'node:os';
import path from 'node:path';

import { config } from './config.js';
import type { RerankCandidate } from './reranker.js';

// Spike findings (validated 2026-03-23):
// - resolveModelFile(hfUri, dir) downloads & caches → returns local path
// - loadModel({ modelPath }) loads the GGUF
// - createEmbeddingContext() → getEmbeddingFor(text) → { vector: readonly number[] } (1024-dim for BGE-M3)
// - createRankingContext() → rank(query, doc) → number 0-1 (probability, sigmoid applied)
// - rankAll(query, docs[]) → number[] (batch scoring)
// - GGUF repos: gpustack org, not BAAI org

// ── Constants ─────────────────────────────────────────────────────────────────
const EMBED_MODEL_URI = 'hf:gpustack/bge-m3-GGUF/bge-m3-Q4_K_M.gguf';
const RERANKER_MODEL_URI = 'hf:gpustack/bge-reranker-v2-m3-GGUF/bge-reranker-v2-m3-Q4_K_M.gguf';

function getModelsDir(): string {
  // node-llama-cpp default cache dir
  return path.join(os.homedir(), '.node-llama-cpp', 'models');
}

// ── Singleton Llama instance ──────────────────────────────────────────────────
let llamaInstance: Llama | null = null;
let llamaPromise: Promise<Llama> | null = null;

async function getLlamaInstance(): Promise<Llama> {
  if (llamaInstance) return llamaInstance;
  if (!llamaPromise) {
    llamaPromise = (async () => {
      try {
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
  const ctx = await getEmbedContext();
  const prefix = type === 'query' ? 'query: ' : 'passage: ';
  const results: (Float32Array | null)[] = [];

  for (let i = 0; i < texts.length; i += config.batchSize) {
    const batch = texts.slice(i, i + config.batchSize);
    const batchResults = await Promise.all(
      batch.map(async (text) => {
        try {
          const embedding = await ctx.getEmbeddingFor(prefix + text);
          return new Float32Array(embedding.vector);
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
