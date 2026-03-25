import path from 'node:path';

export const config = {
  get vaultPath(): string {
    const v = process.env.OBSIDIAN_VAULT_PATH;
    if (!v) throw new Error('OBSIDIAN_VAULT_PATH environment variable is required');
    return v;
  },
  get ignorePatterns(): string[] {
    return (process.env.OBSIDIAN_IGNORE_PATTERNS ?? '.obsidian/**,templates/**,*.canvas')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
  },
  get apiKey(): string | undefined {
    return process.env.OPENAI_API_KEY;
  },
  get apiBaseUrl(): string {
    return process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
  },
  get apiModel(): string {
    return process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small';
  },
  get localModel(): string {
    return process.env.LOCAL_EMBEDDING_MODEL ?? 'Xenova/multilingual-e5-small';
  },
  get rerankerModel(): string {
    return process.env.RERANKER_MODEL ?? 'onnx-community/bge-reranker-v2-m3-ONNX';
  },
  get dbPath(): string {
    const v = process.env.OBSIDIAN_VAULT_PATH;
    if (!v) throw new Error('OBSIDIAN_VAULT_PATH environment variable is required');
    return path.join(v, '.obsidian-hybrid-search.db');
  },
  // internal defaults
  chunkContextFallback: 512,
  chunkOverlap: 64,
  chunkMinLength: 50,
  chunkHeadingLevel: 0,
  batchSize: 10,
  debounce: 10_000,
};
