import { config } from './config.js'

let localPipeline: any = null
let cachedContextLength: number | null = null
let cachedDim: number | null = null

// Known context lengths for embedding models available on OpenRouter
// Source: https://openrouter.ai/api/v1/embeddings/models
const KNOWN_CONTEXT_LENGTHS: Record<string, number> = {
  // OpenAI
  'openai/text-embedding-3-small': 8192,
  'openai/text-embedding-3-large': 8192,
  'openai/text-embedding-ada-002': 8192,
  // Short-form aliases (for direct OpenAI API usage)
  'text-embedding-3-small': 8192,
  'text-embedding-3-large': 8192,
  'text-embedding-ada-002': 8192,
  // Mistral
  'mistralai/mistral-embed': 8192,
  'mistralai/mistral-embed-2312': 8192,
  'mistralai/codestral-embed-2505': 8192,
  // Google
  'google/gemini-embedding-001': 20000,
  // Qwen
  'qwen/qwen3-embedding-8b': 32000,
  'qwen/qwen3-embedding-4b': 32768,
  // BAAI
  'baai/bge-m3': 8192,
  'baai/bge-base-en-v1.5': 512,
  'baai/bge-large-en-v1.5': 512,
  // Sentence Transformers
  'sentence-transformers/all-minilm-l6-v2': 512,
  'sentence-transformers/all-minilm-l12-v2': 512,
  'sentence-transformers/all-mpnet-base-v2': 512,
  'sentence-transformers/multi-qa-mpnet-base-dot-v1': 512,
  'sentence-transformers/paraphrase-minilm-l6-v2': 512,
  // intfloat E5
  'intfloat/e5-large-v2': 512,
  'intfloat/e5-base-v2': 512,
  'intfloat/multilingual-e5-large': 512,
  // thenlper GTE
  'thenlper/gte-base': 512,
  'thenlper/gte-large': 512,
  // NVIDIA
  'nvidia/llama-nemotron-embed-vl-1b-v2': 131072,
}

export async function getContextLength(): Promise<number> {
  if (cachedContextLength !== null) return cachedContextLength

  if (config.apiKey) {
    // Check known models first
    if (KNOWN_CONTEXT_LENGTHS[config.apiModel]) {
      cachedContextLength = KNOWN_CONTEXT_LENGTHS[config.apiModel]
      return cachedContextLength
    }

    try {
      const res = await fetch(
        `${config.apiBaseUrl}/models/${config.apiModel}`,
        { headers: { Authorization: `Bearer ${config.apiKey}` } }
      )
      const data = await res.json() as { context_length?: number }
      cachedContextLength = data.context_length ?? config.chunkContextFallback
      return cachedContextLength
    } catch {
      // fall through to default
    }
  } else {
    // Local model: try to read from pipeline config
    try {
      const pipeline = await getLocalPipeline()
      const maxLen = pipeline.model?.config?.max_position_embeddings
      if (typeof maxLen === 'number') {
        cachedContextLength = maxLen
        return cachedContextLength
      }
    } catch {
      // fall through
    }
  }

  cachedContextLength = config.chunkContextFallback
  return cachedContextLength
}

export async function getEmbeddingDim(): Promise<number> {
  if (cachedDim !== null) return cachedDim
  const [embedding] = await embed(['dimension probe'])
  cachedDim = embedding.length
  return cachedDim
}

async function getLocalPipeline() {
  if (!localPipeline) {
    const { pipeline } = await import('@xenova/transformers')
    localPipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')
  }
  return localPipeline
}

export async function embed(texts: string[]): Promise<Float32Array[]> {
  if (config.apiKey) {
    return embedViaApi(texts)
  }
  return embedLocal(texts)
}

async function embedViaApi(texts: string[]): Promise<Float32Array[]> {
  const results: Float32Array[] = []

  for (let i = 0; i < texts.length; i += config.batchSize) {
    const batch = texts.slice(i, i + config.batchSize)
    const batchResults = await embedApiBatchWithFallback(batch)
    results.push(...batchResults)
  }

  return results
}

async function embedApiBatch(texts: string[]): Promise<Float32Array[]> {
  const res = await fetch(`${config.apiBaseUrl}/embeddings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: config.apiModel, input: texts }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Embedding API error ${res.status}: ${text}`)
  }

  const data = await res.json() as { data?: { embedding: number[]; index: number }[]; error?: { message: string } }
  if (data.error || !data.data) {
    throw new Error(`Embedding API error: ${data.error?.message ?? 'unexpected response format'}`)
  }

  return data.data
    .sort((a, b) => a.index - b.index)
    .map(item => new Float32Array(item.embedding))
}

async function embedApiBatchWithFallback(texts: string[]): Promise<Float32Array[]> {
  // Try the whole batch first
  try {
    return await embedApiBatch(texts)
  } catch (batchErr) {
    if (texts.length === 1) {
      // Try with progressively shorter truncations
      for (const limit of [2000, 1000, 500]) {
        const truncated = texts[0].slice(0, limit)
        if (truncated === texts[0]) continue // already shorter, no point retrying
        try {
          console.warn(`[embedder] chunk failing, retrying at ${limit} chars`)
          return await embedApiBatch([truncated])
        } catch {
          // try next truncation level
        }
      }
      // All truncations failed — use zero vector so the note still indexes for BM25
      if (cachedDim !== null) {
        console.warn('[embedder] chunk unembeddable, using zero vector (note still indexed for text search)')
        return [new Float32Array(cachedDim)]
      }
      throw batchErr
    }
    // Batch failed — retry each item individually
    console.warn('[embedder] batch failed, retrying one by one:', (batchErr as Error).message)
    const results: Float32Array[] = []
    for (const text of texts) {
      const [emb] = await embedApiBatchWithFallback([text])
      results.push(emb)
    }
    return results
  }
}

async function embedLocal(texts: string[]): Promise<Float32Array[]> {
  const pipeline = await getLocalPipeline()
  const results: Float32Array[] = []

  for (let i = 0; i < texts.length; i += config.batchSize) {
    const batch = texts.slice(i, i + config.batchSize)
    await Promise.all(
      batch.map(async (text) => {
        const output = await pipeline(text, { pooling: 'mean', normalize: true })
        results.push(new Float32Array(output.data))
      })
    )
  }

  return results
}
