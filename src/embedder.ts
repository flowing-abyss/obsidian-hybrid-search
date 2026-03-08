import { config } from './config.js';

let localPipeline: any = null;
let cachedContextLength: number | null = null;
let cachedDim: number | null = null;

// Known context lengths for embedding models across all providers.
// Used to avoid an API roundtrip on startup and ensure correct chunking.
// Sources: OpenRouter /api/v1/embeddings/models, Ollama library,
//          Voyage AI docs, Cohere docs, OpenAI docs.
const KNOWN_CONTEXT_LENGTHS: Record<string, number> = {
  // ── OpenAI (direct API and OpenRouter) ───────────────────
  'openai/text-embedding-3-small': 8192,
  'openai/text-embedding-3-large': 8192,
  'openai/text-embedding-ada-002': 8192,
  'text-embedding-3-small': 8192,
  'text-embedding-3-large': 8192,
  'text-embedding-ada-002': 8192,

  // ── Mistral ───────────────────────────────────────────────
  'mistralai/mistral-embed': 8192,
  'mistralai/mistral-embed-2312': 8192,
  'mistralai/codestral-embed-2505': 8192,
  'mistral-embed': 8192,

  // ── Google ────────────────────────────────────────────────
  'google/gemini-embedding-001': 20000,
  'gemini-embedding-001': 20000,
  'text-embedding-004': 2048, // Google AI direct
  'text-multilingual-embedding-002': 2048,

  // ── Qwen ─────────────────────────────────────────────────
  'qwen/qwen3-embedding-8b': 32000,
  'qwen/qwen3-embedding-4b': 32768,
  'qwen3-embedding-8b': 32000,
  'qwen3-embedding-4b': 32768,

  // ── Cohere ────────────────────────────────────────────────
  'cohere/embed-english-v3.0': 512,
  'cohere/embed-multilingual-v3.0': 512,
  'cohere/embed-english-light-v3.0': 512,
  'cohere/embed-multilingual-light-v3.0': 512,
  'embed-english-v3.0': 512,
  'embed-multilingual-v3.0': 512,
  'embed-english-light-v3.0': 512,
  'embed-multilingual-light-v3.0': 512,

  // ── Voyage AI ─────────────────────────────────────────────
  'voyage-4-large': 32000,
  'voyage-4': 32000,
  'voyage-4-lite': 32000,
  'voyage-4-nano': 32000,
  'voyage-3-large': 32000,
  'voyage-3.5': 32000,
  'voyage-3.5-lite': 32000,
  'voyage-3': 32000,
  'voyage-3-lite': 32000,
  'voyage-code-3': 32000,
  'voyage-finance-2': 32000,
  'voyage-multilingual-2': 32000,
  'voyage-large-2-instruct': 16000,
  'voyage-large-2': 16000,
  'voyage-law-2': 16000,
  'voyage-code-2': 16000,
  'voyage-2': 4000,

  // ── BAAI BGE (OpenRouter + Ollama short names) ────────────
  'baai/bge-m3': 8192,
  'baai/bge-base-en-v1.5': 512,
  'baai/bge-large-en-v1.5': 512,
  'bge-m3': 8192,
  'bge-large': 512,
  'bge-base': 512,

  // ── Sentence Transformers ─────────────────────────────────
  'sentence-transformers/all-minilm-l6-v2': 512,
  'sentence-transformers/all-minilm-l12-v2': 512,
  'sentence-transformers/all-mpnet-base-v2': 512,
  'sentence-transformers/multi-qa-mpnet-base-dot-v1': 512,
  'sentence-transformers/paraphrase-minilm-l6-v2': 512,

  // ── intfloat E5 ───────────────────────────────────────────
  'intfloat/e5-large-v2': 512,
  'intfloat/e5-base-v2': 512,
  'intfloat/multilingual-e5-large': 512,

  // ── thenlper GTE ──────────────────────────────────────────
  'thenlper/gte-base': 512,
  'thenlper/gte-large': 512,

  // ── NVIDIA ────────────────────────────────────────────────
  'nvidia/llama-nemotron-embed-vl-1b-v2': 131072,

  // ── Ollama local models (short names) ────────────────────
  'nomic-embed-text': 8192,
  'nomic-embed-text-v1.5': 8192,
  'mxbai-embed-large': 512,
  'all-minilm': 512,
  'snowflake-arctic-embed': 512,
  'paraphrase-multilingual': 512,
};

export async function getContextLength(): Promise<number> {
  if (cachedContextLength !== null) return cachedContextLength;

  if (useApiMode()) {
    // Check known models first — avoids an API roundtrip
    if (KNOWN_CONTEXT_LENGTHS[config.apiModel]) {
      cachedContextLength = KNOWN_CONTEXT_LENGTHS[config.apiModel];
      return cachedContextLength;
    }

    try {
      const headers: Record<string, string> = {};
      if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;
      const res = await fetch(`${config.apiBaseUrl}/models/${config.apiModel}`, { headers });
      const data = (await res.json()) as { context_length?: number };
      cachedContextLength = data.context_length ?? config.chunkContextFallback;
      return cachedContextLength;
    } catch {
      // fall through to default
    }
  } else {
    // Local model: try to read from pipeline config
    try {
      const pipeline = await getLocalPipeline();
      const maxLen = pipeline.model?.config?.max_position_embeddings;
      if (typeof maxLen === 'number') {
        cachedContextLength = maxLen;
        return cachedContextLength;
      }
    } catch {
      // fall through
    }
  }

  cachedContextLength = config.chunkContextFallback;
  return cachedContextLength;
}

export async function getEmbeddingDim(): Promise<number> {
  if (cachedDim !== null) return cachedDim;
  const [embedding] = await embed(['dimension probe']);
  cachedDim = embedding.length;
  return cachedDim;
}

async function getLocalPipeline() {
  if (!localPipeline) {
    const { pipeline } = await import('@xenova/transformers');
    localPipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  return localPipeline;
}

// Ollama queues requests internally — parallel batches don't help and can crash
// buggy versions (v0.12.5+ bug: requests >2KB crash the server).
function isOllamaEndpoint(): boolean {
  const url = config.apiBaseUrl.toLowerCase();
  return url.includes('11434') || url.includes('ollama');
}

// Use API mode when an API key is set OR when a custom base URL is configured
// (e.g. Ollama, LM Studio, local OpenAI-compatible servers — no key required)
function useApiMode(): boolean {
  return !!(config.apiKey || process.env.OPENAI_BASE_URL);
}

export async function embed(texts: string[]): Promise<Float32Array[]> {
  if (useApiMode()) {
    return embedViaApi(texts);
  }
  return embedLocal(texts);
}

async function embedViaApi(texts: string[]): Promise<Float32Array[]> {
  const results: Float32Array[] = [];

  // Ollama: send one at a time to avoid the >2KB crash bug in v0.12.5+
  // and because Ollama queues internally anyway (batching gives no speedup)
  const batchSize = isOllamaEndpoint() ? 1 : config.batchSize;

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const batchResults = await embedApiBatchWithFallback(batch);
    results.push(...batchResults);
  }

  return results;
}

async function embedApiBatch(texts: string[]): Promise<Float32Array[]> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;

  const res = await fetch(`${config.apiBaseUrl}/embeddings`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: config.apiModel, input: texts }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Embedding API error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as {
    data?: { embedding: number[]; index: number }[];
    error?: { message: string };
  };
  if (data.error || !data.data) {
    throw new Error(`Embedding API error: ${data.error?.message ?? 'unexpected response format'}`);
  }

  return data.data
    .sort((a, b) => a.index - b.index)
    .map((item) => new Float32Array(item.embedding));
}

async function embedApiBatchWithFallback(texts: string[]): Promise<Float32Array[]> {
  // Try the whole batch first
  try {
    return await embedApiBatch(texts);
  } catch (batchErr) {
    if (texts.length === 1) {
      // Try with progressively shorter truncations
      for (const limit of [2000, 1000, 500]) {
        const truncated = texts[0].slice(0, limit);
        if (truncated === texts[0]) continue; // already shorter, no point retrying
        try {
          console.warn(`[embedder] chunk failing, retrying at ${limit} chars`);
          return await embedApiBatch([truncated]);
        } catch {
          // try next truncation level
        }
      }
      // All truncations failed — use zero vector so the note still indexes for BM25
      if (cachedDim !== null) {
        console.warn(
          '[embedder] chunk unembeddable, using zero vector (note still indexed for text search)',
        );
        return [new Float32Array(cachedDim)];
      }
      throw batchErr;
    }
    // Batch failed — retry each item individually
    console.warn('[embedder] batch failed, retrying one by one:', (batchErr as Error).message);
    const results: Float32Array[] = [];
    for (const text of texts) {
      const [emb] = await embedApiBatchWithFallback([text]);
      results.push(emb);
    }
    return results;
  }
}

async function embedLocal(texts: string[]): Promise<Float32Array[]> {
  const pipeline = await getLocalPipeline();
  const results: Float32Array[] = [];

  for (let i = 0; i < texts.length; i += config.batchSize) {
    const batch = texts.slice(i, i + config.batchSize);
    await Promise.all(
      batch.map(async (text) => {
        const output = await pipeline(text, { pooling: 'mean', normalize: true });
        results.push(new Float32Array(output.data));
      }),
    );
  }

  return results;
}
