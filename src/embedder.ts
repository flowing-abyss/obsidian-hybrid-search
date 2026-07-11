import os from 'node:os';
import path from 'node:path';
import {
  EmbeddingApiResponseSchema,
  formatValidationError,
  OllamaEmbeddingResponseSchema,
} from './boundary-validation.js';
import { config } from './config.js';
import {
  createEstimatedTokenCounter,
  createOpenAiTokenCounter,
  effectiveTokenLimit,
  normalizeKnownModelName,
} from './token-counter.js';

export const LOCAL_MODEL = 'Xenova/multilingual-e5-small';

export type EmbeddingFailureKind =
  'input_too_long' | 'transient' | 'permanent' | 'invalid_response';

export type EmbeddingOutcome =
  | { ok: true; embedding: Float32Array }
  | {
      ok: false;
      kind: EmbeddingFailureKind;
      status?: number;
      providerCode?: string | number;
      message: string;
    };

type EmbeddingFailure = Extract<EmbeddingOutcome, { ok: false }>;

type EmbeddingBatchAttempt =
  | { ok: true; embeddings: Float32Array[] }
  | { ok: false; failure: EmbeddingFailure; localize: boolean; retryable?: boolean };

function getCacheDir(): string {
  return path.join(os.homedir(), '.cache', 'huggingface');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Hugging Face transformers pipeline has no types
let localPipeline: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Hugging Face transformers pipeline has no types
let localPipelinePromise: Promise<any> | null = null;
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
  'nomic-embed-text-v2-moe': 512,
  'mxbai-embed-large': 512,
  'all-minilm': 512,
  'snowflake-arctic-embed': 512,
  'snowflake-arctic-embed2': 8192,
  'paraphrase-multilingual': 512,
  embeddinggemma: 2048,
  'granite-embedding': 512,

  // ── Xenova-prefix models (compatible with @huggingface/transformers v3) ────────────────────
  'Xenova/multilingual-e5-small': 512,
  'Xenova/multilingual-e5-base': 512,
  'Xenova/nomic-embed-text-v1.5': 8192,
  'Xenova/all-MiniLM-L6-v2': 256, // real tokenizer limit, not max_position_embeddings
  'Xenova/all-MiniLM-L12-v2': 256,
  'Xenova/bge-small-en-v1.5': 512,
  'Xenova/paraphrase-multilingual-MiniLM-L12-v2': 512,

  // ── onnx-community models ─────────────────────────────────
  'onnx-community/gte-multilingual-base': 8192,
  'onnx-community/embeddinggemma-300m-ONNX': 2048,
};

export async function getContextLength(): Promise<number> {
  if (cachedContextLength !== null) return cachedContextLength;

  if (useApiMode()) {
    // Check known models first — avoids an API roundtrip
    const knownModel = isOllamaEndpoint()
      ? normalizeKnownModelName(config.apiModel)
      : config.apiModel;
    if (KNOWN_CONTEXT_LENGTHS[knownModel]) {
      cachedContextLength = KNOWN_CONTEXT_LENGTHS[knownModel]!;
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
    // Keep token-policy construction independent of model initialization. Unknown
    // local models use the configured fallback and are still validated exactly
    // with their tokenizer immediately before document inference.
    if (KNOWN_CONTEXT_LENGTHS[config.localModel]) {
      cachedContextLength = KNOWN_CONTEXT_LENGTHS[config.localModel]!;
      return cachedContextLength;
    }
  }

  cachedContextLength = config.chunkContextFallback;
  return cachedContextLength;
}

export async function getEmbeddingDim(): Promise<number> {
  if (cachedDim !== null) return cachedDim;
  const [embedding] = await embed(['dimension probe']);
  if (!embedding) throw new Error('[embedder] dimension probe failed — embedding returned null');
  cachedDim = embedding.length;
  return cachedDim;
}

/**
 * Pre-seed the in-memory embedding dimension cache from a value read out of the
 * DB settings table.  Call this instead of getEmbeddingDim() when the dimension
 * is already stored so we avoid an unnecessary API round-trip on startup.
 * Also ensures the null fallback in embedApiBatchWithFallback does not trigger
 * for an already-known dim, since the dim is cached before any embedding call.
 */
export function primeEmbeddingDim(dim: number): void {
  if (cachedDim === null) cachedDim = dim;
}

async function getLocalPipeline() {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- Hugging Face transformers pipeline has no types
  if (localPipeline) return localPipeline;
  if (!localPipelinePromise) {
    localPipelinePromise = (async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- optional dependency, may not be installed
      let hf: any;
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        hf = await import('@huggingface/transformers');
      } catch {
        throw new Error(
          '[embedder] @huggingface/transformers is not installed (optional dependency missing).\n' +
            'To use the built-in local model, reinstall without --no-optional:\n' +
            '  npm install -g obsidian-hybrid-search\n' +
            'To use an external embedding provider instead (Ollama, OpenAI, OpenRouter), set:\n' +
            '  OPENAI_BASE_URL=http://localhost:11434/v1  # Ollama example\n' +
            '  OPENAI_EMBEDDING_MODEL=bge-m3',
        );
      }
      // Redirect cache to ~/.cache/huggingface so models survive npm install / node_modules wipes.
      // @huggingface/transformers v3 does not read HF_HOME — env.cacheDir must be set explicitly.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- @huggingface/transformers has no TypeScript types
      hf.env.cacheDir = getCacheDir();
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return -- @huggingface/transformers has no TypeScript types
      return hf.pipeline('feature-extraction', config.localModel, {
        // device:'cpu' avoids silent fp32 fallback that occurs when 'auto' selects
        // an EP (CoreML/CUDA) that doesn't support the model's ONNX opsets.
        device: 'cpu',
        // dtype:'q8' loads model_quantized.onnx (~30 MB) instead of the fp32
        // model.onnx (~470 MB), halving RSS with no meaningful quality drop.
        dtype: 'q8',
      });
    })();
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Hugging Face transformers pipeline has no types
    localPipeline = await localPipelinePromise;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- @huggingface/transformers has no TypeScript types
    return localPipeline;
  } catch (error) {
    localPipelinePromise = null;
    throw error;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

// E5 model family (intfloat/Xenova e5-*) uses asymmetric prefixes ("query:"/"passage:").
// BGE, GTE, Nomic, Gemma, and most other models do NOT — adding prefixes corrupts their embeddings.
function needsE5Prefix(model: string): boolean {
  return /\/e5|e5[-_]/i.test(model);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Hugging Face transformers pipeline has no types
function getLocalValidationContextLength(pipeline: any): number {
  const known = KNOWN_CONTEXT_LENGTHS[config.localModel];
  if (known) return known;

  /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- Hugging Face transformers pipeline has no types */
  const tokenizerMax: unknown = pipeline.tokenizer?.model_max_length;
  const modelMax: unknown = pipeline.model?.config?.max_position_embeddings;
  /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
  for (const candidate of [tokenizerMax, modelMax]) {
    if (
      typeof candidate === 'number' &&
      Number.isInteger(candidate) &&
      candidate > 0 &&
      candidate <= 1_000_000
    ) {
      return candidate;
    }
  }
  return config.chunkContextFallback;
}

export function prepareEmbeddingInput(text: string, type: 'query' | 'document'): string {
  const model = useApiMode() ? config.apiModel : config.localModel;
  if (!needsE5Prefix(model)) return text;
  return `${type === 'query' ? 'query: ' : 'passage: '}${text}`;
}

export async function getDocumentTokenPolicy(): Promise<{
  limit: number;
  count(text: string): number;
}> {
  const limit = effectiveTokenLimit(await getContextLength());
  const estimated = createEstimatedTokenCounter();
  if (useApiMode()) {
    let counter = estimated;
    if (!isOllamaEndpoint()) {
      try {
        counter = (await createOpenAiTokenCounter(config.apiModel)) ?? estimated;
      } catch {
        // A missing or corrupt bundled tokenizer must not prevent indexing.
      }
    }
    return { limit, count: (text) => counter.count(prepareEmbeddingInput(text, 'document')) };
  }
  return {
    limit,
    count: (text) => estimated.count(prepareEmbeddingInput(text, 'document')),
  };
}

const OLLAMA_MAX_CONCURRENCY = 1;

let activeOllamaRequests = 0;
const ollamaWaitQueue: Array<() => void> = [];

function acquireOllamaSlot(): Promise<() => void> {
  return new Promise((resolveRelease) => {
    const tryAcquire = () => {
      if (activeOllamaRequests < OLLAMA_MAX_CONCURRENCY) {
        activeOllamaRequests++;
        resolveRelease(() => {
          activeOllamaRequests--;
          const next = ollamaWaitQueue.shift();
          if (next) next();
        });
      } else {
        ollamaWaitQueue.push(tryAcquire);
      }
    };
    tryAcquire();
  });
}

/** Reset semaphore state — for tests only */
export function clearOllamaSemaphore(): void {
  activeOllamaRequests = 0;
  ollamaWaitQueue.length = 0;
  localPipeline = null;
  localPipelinePromise = null;
  cachedContextLength = null;
}

async function embedViaApiDetailed(
  texts: string[],
  type: 'query' | 'document',
): Promise<EmbeddingOutcome[]> {
  if (isOllamaEndpoint() && type === 'document') {
    const release = await acquireOllamaSlot();
    try {
      return await embedViaApiRawDetailed(texts);
    } finally {
      release();
    }
  }
  return embedViaApiRawDetailed(texts);
}

export async function embedDetailed(
  texts: string[],
  type: 'query' | 'document' = 'document',
): Promise<EmbeddingOutcome[]> {
  const preparedTexts = texts.map((text) => prepareEmbeddingInput(text, type));
  if (useApiMode()) {
    return embedViaApiDetailed(preparedTexts, type);
  }
  if (type === 'query') return localEmbeddingOutcomes(await embedLocal(preparedTexts));

  // The feature-extraction pipeline silently truncates. Validate each final
  // document leaf once so the indexer can split oversized inputs before inference.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Hugging Face transformers pipeline has no types
  const pipeline = await getLocalPipeline();
  const limit = effectiveTokenLimit(getLocalValidationContextLength(pipeline));
  const outcomes: Array<EmbeddingOutcome | undefined> = Array.from(
    { length: preparedTexts.length },
    () => undefined,
  );
  const fittingTexts: string[] = [];
  const fittingIndexes: number[] = [];

  for (let index = 0; index < preparedTexts.length; index++) {
    const text = preparedTexts[index]!;
    let tokenCount: number;
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- tokenizer has no TypeScript types
      const ids: unknown = pipeline.tokenizer.encode(text, { add_special_tokens: true });
      if (!Array.isArray(ids))
        throw new Error('Local tokenizer returned an invalid token sequence');
      tokenCount = ids.length;
    } catch {
      outcomes[index] = failureOutcome(
        'invalid_response',
        'Local tokenizer failed to count prepared input',
      );
      continue;
    }

    if (tokenCount > limit) {
      outcomes[index] = failureOutcome(
        'input_too_long',
        `Local embedding input exceeds the ${limit} token limit (${tokenCount} tokens)`,
      );
      continue;
    }
    fittingTexts.push(text);
    fittingIndexes.push(index);
  }

  const fittingOutcomes = localEmbeddingOutcomes(await embedLocal(fittingTexts, pipeline));
  for (let index = 0; index < fittingIndexes.length; index++) {
    outcomes[fittingIndexes[index]!] = fittingOutcomes[index];
  }
  return outcomes.map(
    (outcome) => outcome ?? failureOutcome('permanent', 'Local embedding returned no outcome'),
  );
}

function localEmbeddingOutcomes(embeddings: (Float32Array | null)[]): EmbeddingOutcome[] {
  return embeddings.map((embedding) =>
    embedding ? { ok: true, embedding } : failureOutcome('permanent', 'Local embedding failed'),
  );
}

export async function embed(
  texts: string[],
  type: 'query' | 'document' = 'document',
): Promise<(Float32Array | null)[]> {
  const outcomes = await embedDetailed(texts, type);
  return outcomes.map((outcome) => (outcome.ok ? outcome.embedding : null));
}

async function embedViaApiRawDetailed(texts: string[]): Promise<EmbeddingOutcome[]> {
  const results: EmbeddingOutcome[] = [];
  const batchTransport = isOllamaEndpoint()
    ? embedOllamaBatchWithCompatibleFallback
    : embedApiBatch;

  // Ollama: send one at a time to avoid the >2KB crash bug in v0.12.5+
  // and because Ollama queues internally anyway (batching gives no speedup)
  const batchSize = isOllamaEndpoint() ? 1 : config.batchSize;

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const batchResults = await embedApiBatchWithFallback(batch, batchTransport);
    results.push(...batchResults);
  }

  return results;
}

function failureOutcome(
  kind: EmbeddingFailureKind,
  message: string,
  status?: number,
  providerCode?: string | number,
): EmbeddingFailure {
  return {
    ok: false,
    kind,
    ...(status === undefined ? {} : { status }),
    ...(providerCode === undefined ? {} : { providerCode }),
    message,
  };
}

const INPUT_TOKEN_COUNT_PATTERNS = [
  /\b(?:input|prompt)\s+(?:has|contains|uses)\s+(\d[\d,.]*)\s+tokens?\b/,
  /\b(?:input|prompt)\s+tokens?\s+(?:count|length)\s+(?:is|was|of)\s+(\d[\d,.]*)\b/,
  /\b(?:input|prompt)\s+tokens?\s+(?:count|length)\s*[=:]\s*(\d[\d,.]*)\b/,
  /\btoken\s+(?:count|length)\s+of\s+(?:the\s+)?(?:input|prompt)\s+(?:is|was)\s+(\d[\d,.]*)\b/,
  /\btoken\s+(?:count|length)\s+of\s+(?:the\s+)?(?:input|prompt)\s*[=:]\s*(\d[\d,.]*)\b/,
];

const TOKEN_LIMIT_PATTERNS = [
  /\b(?:limit|maximum|max)\s+(?:is|of)\s+(\d[\d,.]*)\b/,
  /\b(?:limit|maximum|max)\s*[=:]\s*(\d[\d,.]*)\b/,
  /\b(?:limit|maximum|max)\s+(\d[\d,.]*)\b/,
  /\b(\d[\d,.]*)\s+(?:token\s+)?(?:limit|maximum|max)\b/,
];

function parseTokenNumber(value: string): number {
  return Number(value.replace(/[^\d]/g, ''));
}

function findFirstTokenNumber(message: string, patterns: readonly RegExp[]): number | undefined {
  for (const pattern of patterns) {
    const raw = pattern.exec(message)?.[1];
    if (raw) return parseTokenNumber(raw);
  }
  return undefined;
}

function findNonOutputTokenLimit(message: string): number | undefined {
  for (const clause of message.split(/[.;\n]/)) {
    if (/\b(?:response|output|completion)\b/.test(clause)) continue;
    const limit = findFirstTokenNumber(clause, TOKEN_LIMIT_PATTERNS);
    if (limit !== undefined) return limit;
  }
  return undefined;
}

function isInputTooLong(
  message: string,
  providerCode?: string | number,
  providerType?: string,
  metadataType?: string,
): boolean {
  const structuredValues = [providerCode, providerType, metadataType]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.toLowerCase());
  if (
    structuredValues.some((value) =>
      /^(?:context_length_exceeded|input_too_long|context_length_error)$/.test(value),
    )
  ) {
    return true;
  }

  const normalized = message.toLowerCase();
  const exceedsLimit = /(?:exceed|maximum|max|too long|limit|overflow)/.test(normalized);
  const contextLengthSubject = /\bcontext\s+(?:length|window|size|limit|token\s+limit)\b/.test(
    normalized,
  );
  const inputLengthSubject = /\b(?:input(?:\[\d+\])?|prompt)\s+(?:length|size)\b/.test(normalized);
  const tokenSizeSubject = /\btoken\s+(?:count|length|limit|budget)\b/.test(normalized);
  const explicitLengthSubject = contextLengthSubject || inputLengthSubject || tokenSizeSubject;
  const explicitlyTooLong = /\b(?:input|prompt)(?:\[\d+\])?\s+(?:is\s+)?too\s+long\b/.test(
    normalized,
  );
  const hasInputSubject = /\b(?:input|context|prompt)\b/.test(normalized);
  const hasNumericTokenCount = /\b\d[\d,.]*\s+tokens?\b/.test(normalized);
  const hasNumericBound =
    /\b(?:limit|maximum|max)\b/.test(normalized) ||
    /\b(?:less|fewer|more|greater)\s+than\b/.test(normalized);
  if (structuredValues.includes('max_tokens')) {
    const exceedsInputLimit = /(?:exceed|maximum|too long|limit|overflow)/.test(
      normalized.replaceAll('max_tokens', ''),
    );
    const hasDirectInputBound =
      /\b(?:input|prompt)\s+(?:must have|has)\s+(?:less|fewer)\s+than\s+\d[\d,.]*\s+tokens?\b/.test(
        normalized,
      );
    const inputCount = findFirstTokenNumber(normalized, INPUT_TOKEN_COUNT_PATTERNS);
    const inputLimit = findNonOutputTokenLimit(normalized);
    return (
      ((contextLengthSubject || inputLengthSubject) && exceedsInputLimit) ||
      explicitlyTooLong ||
      hasDirectInputBound ||
      (inputCount !== undefined && inputLimit !== undefined && inputCount > inputLimit)
    );
  }
  return (
    (explicitLengthSubject && exceedsLimit) ||
    explicitlyTooLong ||
    (hasInputSubject && hasNumericTokenCount && hasNumericBound) ||
    /\btoo many tokens\b/.test(normalized)
  );
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function classifyProviderFailure(
  status: number,
  error: {
    code?: string | number;
    message?: string;
    type?: string;
    metadata?: { error_type?: string };
  },
): EmbeddingFailure {
  const classificationStatus =
    status >= 200 && status < 300 && typeof error.code === 'number' ? error.code : status;
  const message = error.message ?? `Embedding API error ${classificationStatus}`;
  const providerCode = error.code ?? error.type ?? error.metadata?.error_type;
  if (isInputTooLong(message, error.code, error.type, error.metadata?.error_type)) {
    return failureOutcome('input_too_long', message, status, providerCode);
  }
  const transient = isRetryableStatus(classificationStatus);
  return failureOutcome(transient ? 'transient' : 'permanent', message, status, providerCode);
}

function parseErrorBody(raw: string): {
  code?: string | number;
  message?: string;
  type?: string;
  metadata?: { error_type?: string };
} {
  try {
    const parsed: unknown = JSON.parse(raw);
    const validated = EmbeddingApiResponseSchema.safeParse(parsed);
    if (validated.success && !('data' in validated.data)) return validated.data.error;
  } catch {
    // Plain-text provider errors are retained as their message.
  }
  return { message: raw || 'unexpected response format' };
}

async function embedApiBatch(
  texts: string[],
  url = `${stripTrailingSlashes(config.apiBaseUrl)}/embeddings`,
): Promise<EmbeddingBatchAttempt> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: config.apiModel, input: texts }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Embedding API network error';
    return { ok: false, failure: failureOutcome('transient', message), localize: false };
  }

  if (!res.ok) {
    let raw: string;
    try {
      raw = await res.text();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Embedding API error body unreadable';
      return {
        ok: false,
        failure: failureOutcome(
          isRetryableStatus(res.status) ? 'transient' : 'invalid_response',
          message,
          res.status,
        ),
        localize: false,
      };
    }
    const failure = classifyProviderFailure(res.status, parseErrorBody(raw));
    return { ok: false, failure, localize: failure.kind === 'input_too_long' };
  }

  let response: unknown;
  try {
    response = await res.json();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Embedding API response unreadable';
    return {
      ok: false,
      failure: failureOutcome('invalid_response', message, res.status),
      localize: false,
    };
  }
  const parsed = EmbeddingApiResponseSchema.safeParse(response);
  if (!parsed.success) {
    return {
      ok: false,
      failure: failureOutcome(
        'invalid_response',
        formatValidationError('Embedding API response invalid', parsed.error),
        res.status,
      ),
      localize: true,
    };
  }

  const data = parsed.data;
  if (!('data' in data)) {
    const failure = classifyProviderFailure(res.status, data.error);
    return { ok: false, failure, localize: failure.kind === 'input_too_long' };
  }

  const seenIndexes = new Set<number>();
  const indexesMatchRequest =
    data.data.length === texts.length &&
    data.data.every((item) => {
      if (item.index < 0 || item.index >= texts.length || seenIndexes.has(item.index)) {
        return false;
      }
      seenIndexes.add(item.index);
      return true;
    });
  if (!indexesMatchRequest) {
    return {
      ok: false,
      failure: failureOutcome(
        'invalid_response',
        'Embedding API error: response indexes do not match requested batch',
        res.status,
      ),
      localize: true,
    };
  }

  return {
    ok: true,
    embeddings: [...data.data]
      .sort((a, b) => a.index - b.index)
      .map((item) => new Float32Array(item.embedding)),
  };
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end--;
  return value.slice(0, end);
}

function getOllamaUrls(): { native: string; compatible: string } {
  const trimmed = stripTrailingSlashes(config.apiBaseUrl);
  const root = trimmed.endsWith('/v1') ? trimmed.slice(0, -3) : trimmed;
  return {
    native: `${root}/api/embed`,
    compatible: `${root}/v1/embeddings`,
  };
}

function parseOllamaError(raw: string): { message?: string } {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
      const error = (parsed as { error?: unknown }).error;
      if (typeof error === 'string') return { message: error };
      if (typeof error === 'object' && error !== null && 'message' in error) {
        const message = (error as { message?: unknown }).message;
        if (typeof message === 'string') return { message };
      }
    }
  } catch {
    // Plain-text Ollama errors are retained below.
  }
  return { message: raw || 'unexpected Ollama response format' };
}

async function embedOllamaBatchWithCompatibleFallback(
  texts: string[],
): Promise<EmbeddingBatchAttempt> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;
  const urls = getOllamaUrls();

  let res: Response;
  try {
    res = await fetch(urls.native, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: config.apiModel, input: texts, truncate: false }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Ollama network error';
    return { ok: false, failure: failureOutcome('transient', message), localize: false };
  }

  if (res.status === 404 || res.status === 405) {
    const compatible = await embedApiBatch(texts, urls.compatible);
    return compatible.ok ? compatible : { ...compatible, retryable: false };
  }
  if (!res.ok) {
    let raw: string;
    try {
      raw = await res.text();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Ollama error body unreadable';
      return {
        ok: false,
        failure: failureOutcome(
          isRetryableStatus(res.status) ? 'transient' : 'invalid_response',
          message,
          res.status,
        ),
        localize: false,
      };
    }
    const failure = classifyProviderFailure(res.status, parseOllamaError(raw));
    return { ok: false, failure, localize: failure.kind === 'input_too_long' };
  }

  let response: unknown;
  try {
    response = await res.json();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Ollama response unreadable';
    return {
      ok: false,
      failure: failureOutcome('invalid_response', message, res.status),
      localize: false,
    };
  }
  const parsed = OllamaEmbeddingResponseSchema.safeParse(response);
  if (!parsed.success) {
    return {
      ok: false,
      failure: failureOutcome(
        'invalid_response',
        formatValidationError('Ollama embedding response invalid', parsed.error),
        res.status,
      ),
      localize: true,
    };
  }

  const embeddings = parsed.data.embeddings;
  const dimension = embeddings[0]?.length ?? 0;
  if (
    embeddings.length !== texts.length ||
    dimension === 0 ||
    embeddings.some((embedding) => embedding.length !== dimension)
  ) {
    return {
      ok: false,
      failure: failureOutcome(
        'invalid_response',
        'Ollama embedding response dimensions do not match requested batch',
        res.status,
      ),
      localize: true,
    };
  }

  return { ok: true, embeddings: embeddings.map((embedding) => new Float32Array(embedding)) };
}

type EmbeddingBatchTransport = (texts: string[]) => Promise<EmbeddingBatchAttempt>;

async function embedApiBatchWithRetries(
  texts: string[],
  transport: EmbeddingBatchTransport,
): Promise<EmbeddingBatchAttempt> {
  let result = await transport(texts);
  if (result.ok || result.failure.kind !== 'transient' || result.retryable === false) return result;

  for (let attempt = 1; attempt <= 2; attempt++) {
    await sleep(Math.pow(2, attempt) * 1000); // 2s, 4s
    result = await transport(texts);
    if (result.ok || result.failure.kind !== 'transient' || result.retryable === false)
      return result;
  }
  return result;
}

async function embedApiBatchWithFallback(
  texts: string[],
  transport: EmbeddingBatchTransport,
): Promise<EmbeddingOutcome[]> {
  const result = await embedApiBatchWithRetries(texts, transport);
  if (result.ok) {
    return result.embeddings.map((embedding) => ({ ok: true, embedding }));
  }
  if (texts.length === 1 || !result.localize) {
    return texts.map(() => ({ ...result.failure }));
  }

  const outcomes: EmbeddingOutcome[] = [];
  for (const text of texts) {
    const [outcome] = await embedApiBatchWithFallback([text], transport);
    if (outcome) {
      outcomes.push(outcome);
    } else {
      outcomes.push(failureOutcome('permanent', 'Embedding API returned no outcome'));
    }
  }
  return outcomes;
}

async function embedLocal(
  texts: string[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- @huggingface/transformers has no TypeScript types
  initializedPipeline?: any,
): Promise<(Float32Array | null)[]> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- @huggingface/transformers has no TypeScript types
  const pipeline = initializedPipeline ?? (await getLocalPipeline());
  const results: (Float32Array | null)[] = [];

  for (let i = 0; i < texts.length; i += config.batchSize) {
    const batch = texts.slice(i, i + config.batchSize);
    const batchResults = await Promise.all(
      batch.map(async (text) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- @huggingface/transformers has no TypeScript types for pipeline output
        const output = await pipeline(text, { pooling: 'mean', normalize: true });
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        return new Float32Array(output.data);
      }),
    );
    results.push(...batchResults);
  }

  return results;
}
