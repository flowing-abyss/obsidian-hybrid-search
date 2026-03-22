# GPU Local Inference — Migration to node-llama-cpp

**Date:** 2026-03-23
**Branch:** `feat/gpu-local-inference`
**Status:** Approved

---

## Problem

The current local embedding and reranking stack uses `@huggingface/transformers` (Xenova/ONNX Runtime Web), which is CPU-only. The default embedding model (`Xenova/multilingual-e5-small`, 384d) is small and low-quality. The reranker (`bge-reranker-v2-m3`, int8) is also CPU-only. GPU acceleration is not possible without routing everything through an external API (Ollama, OpenRouter).

Goal: replace the local inference stack with `node-llama-cpp` — a Node.js binding for llama.cpp — which supports Metal (macOS), CUDA (Linux/Windows), and CPU fallback transparently, and upgrade the default local model to BGE-M3.

---

## Goals

- GPU-accelerated local embeddings and reranking out of the box
- Upgrade default local model: `Xenova/multilingual-e5-small` (384d, 512 ctx) → `BAAI/bge-m3` Q4_K_M (1024d, 8192 ctx)
- Upgrade reranker: ONNX CPU → GGUF GPU (`bge-reranker-v2-m3` Q4_K_M)
- Zero user configuration: `npm install -g obsidian-hybrid-search` → works, no flags needed
- API mode (`OPENAI_API_KEY` or `OPENAI_BASE_URL`) stays completely untouched
- Reranker (`--rerank`) works regardless of embedding mode (API or local)

## Non-Goals

- Keeping `@huggingface/transformers` as a fallback backend
- Supporting arbitrary GGUF models via env var (out of scope for this iteration)
- Changing the reranker's external interface (`--rerank` flag)

---

## Architecture

```
CLI (cli.ts) ──┐
               ├──▶ search() in searcher.ts ──▶ db.ts (SQLite)
MCP (server.ts)┘       │
                        ├──▶ embedder.ts ──┬──▶ API (OpenAI/OpenRouter/Ollama) [unchanged]
                        │                  └──▶ llama-backend.ts
                        │
                        └──▶ reranker.ts ──▶ llama-backend.ts
```

### New file: `src/llama-backend.ts`

Single responsibility: own everything related to `node-llama-cpp`.

**Internals (private):**
- Singleton `Llama` instance (one per process — required by llama.cpp)
- Two `LlamaModel` instances: one for BGE-M3 (embeddings), one for BGE-reranker-v2-m3 (reranking)
- Two `LlamaEmbeddingContext` instances (one per model)
- Auto-download via `node-llama-cpp` built-in `downloadModel()` to `~/.cache/llama-models/`
- Lazy loading: each model loads only on first real call — `llamaEmbed()` triggers the embedding model, `llamaRerank()` triggers the reranker model
- Progress output to stderr on first download (built into `node-llama-cpp`)
- Deduplication guard: a single `loadPromise` per model ensures concurrent callers don't trigger multiple downloads/loads

**Public API:**
```typescript
export async function llamaEmbed(
  texts: string[],
  type: 'query' | 'document',
): Promise<(Float32Array | null)[]>

export async function llamaRerank(
  query: string,
  candidates: RerankCandidate[],
): Promise<number[]>
```

**GPU selection:** `node-llama-cpp` auto-detects Metal (macOS), CUDA (Linux/Windows), CPU fallback — no env var or configuration needed.

**BGE-M3 prefix:** BGE-M3 requires `"query: "` / `"passage: "` prefixes for asymmetric retrieval. These are added manually inside `llamaEmbed()` before passing text to llama.cpp, since GGUF files do not embed this automatically.

**Batching:** `llamaEmbed()` accepts a full `texts[]` array and handles batching internally using `config.batchSize`. `embedder.ts` passes the full array — it no longer slices by `batchSize` before calling the local path.

**Reranker inference:** BGE-reranker-v2-m3 is loaded as an embedding model. Query and document are passed as a pair. The exact logit extraction formula (which scalar, which index) **must be validated during the spike** — do not assume it matches the current ONNX path. Leave the formula as a TODO in the spike output.

---

## Models

| Role | Model | File | Size | Context |
|------|-------|------|------|---------|
| Embeddings | `BAAI/bge-m3` | `bge-m3-Q4_K_M.gguf` | ~370 MB | 8192 tokens |
| Reranking | `BAAI/bge-reranker-v2-m3` | `bge-reranker-v2-m3-Q4_K_M.gguf` | ~320 MB | — |

Both downloaded to `~/.cache/llama-models/` on first use.

---

## File Changes

### `package.json`
- Remove `@huggingface/transformers` from `optionalDependencies` entirely
- Add `node-llama-cpp` to `dependencies` (regular, not optional)
- Note: `node-llama-cpp` downloads pre-built native binaries during `postinstall` (~150–400 MB depending on platform). First `npm install` will take longer than before. This is expected and intentional — the tradeoff is GPU support out of the box.

### `src/llama-backend.ts` (new)
- All `node-llama-cpp` logic lives here
- Exports `llamaEmbed()` and `llamaRerank()`
- Handles lazy loading, deduplication, download, prefix injection, batching

### `src/embedder.ts`
**Remove:**
- `getCacheDir()` function (becomes dead code — `llama-backend.ts` manages its own cache dir)
- `getLocalPipeline()` function
- `embedLocal()` internals — the full body is replaced
- `let localPipeline: any = null` module-level variable

**Update:**
- `LOCAL_MODEL` constant: `'Xenova/multilingual-e5-small'` → `'BAAI/bge-m3'`
- `KNOWN_CONTEXT_LENGTHS`: add `'BAAI/bge-m3': 8192` as a new entry (the existing `'baai/bge-m3': 8192` lowercase entry stays for Ollama/OpenRouter compatibility; the new uppercase entry matches `LOCAL_MODEL` exactly so the `KNOWN_CONTEXT_LENGTHS[LOCAL_MODEL]` lookup at line 141 succeeds)
- `getContextLength()` local fallback path (lines 147–157): remove the `getLocalPipeline()` fallback block entirely. After the KNOWN_CONTEXT_LENGTHS lookup succeeds (guaranteed by the new entry), the fallback is never reached. If somehow it is reached, fall through to `config.chunkContextFallback` as before — do not call into `llama-backend.ts` for this.
- `embedLocal()` body: replace entirely with `return llamaEmbed(texts, type)` — prefix injection and batching are now inside `llama-backend.ts`

**Unchanged:** all API-mode code (`embedViaApi`, `embedApiBatch`, `embedApiBatchWithFallback`, `useApiMode`, `isOllamaEndpoint`, retry logic)

### `src/reranker.ts`
**Remove:**
- `_loadModel()` method
- `ensureLoaded()` method
- `loadPromise` and `pipeline` instance fields
- The `cacheDir` / `isCached` check (moved to `llama-backend.ts`)
- ONNX tokenizer/model loading, logit extraction logic

**Keep:**
- `CrossEncoderReranker` class (preserves interface for `searcher.ts`)
- `modelName` constructor parameter — repurpose as a display/log label only, or remove if `knip` flags it as unused; do not use it to construct file paths
- `scoreAll()` method — body becomes: load error handling wrapper + single call to `llamaRerank(query, candidates)`. Graceful degradation (return zeros on error) stays.
- Module-level `reranker` singleton export

**Post-migration class shape:**
```typescript
export class CrossEncoderReranker {
  constructor(public readonly modelName: string) {}

  async scoreAll(query: string, candidates: RerankCandidate[]): Promise<number[]> {
    if (candidates.length === 0) return [];
    try {
      return await llamaRerank(query, candidates);
    } catch (err) {
      process.stderr.write(`Reranking failed: ... Returning original order.\n`);
      return candidates.map(() => 0);
    }
  }
}
```

Deduplication of concurrent loads is handled inside `llama-backend.ts`, not in `CrossEncoderReranker`.

### `src/config.ts`
- `RERANKER_MODEL` env var and `config.rerankerModel` getter: remove entirely. `llama-backend.ts` hardcodes the GGUF model name. Update the `CrossEncoderReranker` singleton call site in `reranker.ts` to pass the hardcoded string `'BAAI/bge-reranker-v2-m3'` directly, or remove the constructor argument and `modelName` field altogether if `knip` flags them as unused. Run `knip` after to confirm zero issues.

### `test/reranker.test.ts`
- Remove `_loadModel` mock pattern (the method no longer exists)
- Mock `llamaRerank` from `../src/llama-backend.js` instead
- The deduplication test (if present) is deleted — deduplication is now tested in `llama-backend.test.ts`

### `test/llama-backend.test.ts` (new)
- Unit tests for `llamaEmbed()` and `llamaRerank()` with mocked `node-llama-cpp`
- Mock strategy: `vi.mock('node-llama-cpp', () => ({ getLlama: vi.fn(...), ... }))` at the module level — mock the factory functions that `llama-backend.ts` calls at load time
- Test: deduplication — concurrent calls to `llamaEmbed` trigger only one model load
- Test: lazy loading — reranker model not loaded when only `llamaEmbed` is called

---

## Data Migration

BGE-M3 produces 1024-dimensional vectors vs 384d from `multilingual-e5-small`. The existing `db.ts` model-change detection already handles this: on first run after upgrade, it detects the dimension mismatch, wipes the vector store, and triggers a full reindex. No code changes needed in `db.ts`.

---

## User Experience

**Install:**
```
npm install -g obsidian-hybrid-search
# node-llama-cpp postinstall downloads native GPU backend binaries (~150-400 MB)
# This is a one-time cost at install time
```

**First run (models not cached):**
```
[llama] Downloading BAAI/bge-m3 Q4_K_M (~370 MB)...
[llama] 47% ████████░░░░░░░ 175 MB / 370 MB
[llama] BGE-M3 ready (Metal GPU)
```

**Subsequent runs:** models load from `~/.cache/llama-models/`, no download.

**API mode users:** `node-llama-cpp` installs and its GPU binaries are present, but models are never downloaded (lazy loading — `llamaEmbed` / `llamaRerank` are never called in API mode).

**Reranker with API embeddings:** `--rerank` calls `llamaRerank()` directly, independent of embedding mode.

---

## Testing & CI

**Unit tests:** mock `node-llama-cpp` — no GPU required.

**Integration tests:** run without `OPENAI_API_KEY` to validate the full local GPU path. BGE-M3 first-run download (~370 MB) will exceed the current 120s timeout if models are not pre-cached. Update integration test timeout to 600s (10 minutes) to cover cold-start download. In CI, pre-cache models in a setup step before running integration tests.

**`knip`:** after the refactor, run `npm run knip` and remove any fields/methods that become dead code (`modelName` in `CrossEncoderReranker`, `getCacheDir`, etc.). The goal is zero knip issues.

**Eval:** run before and after the migration using the procedure in `eval/README.md`. After confirming nDCG@5 improves over the baseline (0.780), update `eval/results/baseline-no-rerank.json` with the new run and raise (never lower) the floor thresholds in `test/eval/regression.test.ts`.

---

## Implementation Order

1. **`package.json`** — add `node-llama-cpp` to `dependencies`, remove `@huggingface/transformers`. Install first so `npm run build` doesn't fail in later steps.
2. **Spike** — write a scratch script (`scripts/spike-llama.ts`, not committed) that: loads BGE-M3, embeds 2–3 sentences, prints vectors; loads BGE-reranker, scores a query/doc pair, prints the raw output. Determine the correct logit extraction formula for the reranker. Document the result in a comment inside `llama-backend.ts`.
3. **`src/llama-backend.ts`** — implement `llamaEmbed()` and `llamaRerank()` using findings from spike.
4. **`src/embedder.ts`** — remove Xenova code, wire `embedLocal()` to `llamaEmbed()`, fix `KNOWN_CONTEXT_LENGTHS`, update `LOCAL_MODEL`.
5. **`src/reranker.ts`** — slim down `CrossEncoderReranker`, wire `scoreAll()` to `llamaRerank()`, clean up `config.rerankerModel` usage.
6. **`src/config.ts`** — remove/deprecate `RERANKER_MODEL` getter if no longer needed.
7. **Tests** — update `reranker.test.ts` mocks, add `llama-backend.test.ts`.
8. **Verification** — `npm run format && npm run build && npm test && npm run lint && npm run knip`
9. **Eval** — run before/after comparison, update baseline if improved.
10. **Docs/README** — update model info, system requirements, first-run download note.
