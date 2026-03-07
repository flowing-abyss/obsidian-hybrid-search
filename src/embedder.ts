import { config } from './config.js'

let localPipeline: any = null
let cachedContextLength: number | null = null
let cachedDim: number | null = null

// Known context lengths for common embedding models
const KNOWN_CONTEXT_LENGTHS: Record<string, number> = {
  'openai/text-embedding-3-small': 8191,
  'openai/text-embedding-3-large': 8191,
  'openai/text-embedding-ada-002': 8191,
  'text-embedding-3-small': 8191,
  'text-embedding-3-large': 8191,
  'text-embedding-ada-002': 8191,
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
      // Single item still fails — try with truncated text
      const truncated = texts[0].slice(0, 2000)
      if (truncated === texts[0]) throw batchErr
      try {
        console.warn('[embedder] chunk too large, retrying truncated')
        return await embedApiBatch([truncated])
      } catch {
        throw batchErr
      }
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
