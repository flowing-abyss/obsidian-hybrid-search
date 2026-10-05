import path from 'node:path';

export const DEFAULT_RERANKER_MODEL = 'onnx-community/gte-multilingual-reranker-base';

function decodePrefix(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return raw.replace(/\\n/g, '\n');
}

export const config = {
  get obsidianPrefix(): string {
    return process.env.OBSIDIAN_PREFIX ?? '';
  },
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
  get includePatterns(): string[] {
    return (process.env.OBSIDIAN_INCLUDE_PATTERNS ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
  },
  get respectGitignore(): boolean {
    const raw = process.env.OBSIDIAN_RESPECT_GITIGNORE?.trim().toLowerCase();
    return raw !== 'false' && raw !== '0' && raw !== 'no';
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
  /** Text prepended to every search query before embedding (e.g. Qwen3-Embedding's instruction line). `\n` is decoded. */
  get queryPrefix(): string | undefined {
    return decodePrefix(process.env.OHS_QUERY_PREFIX);
  },
  /** Text prepended to every document chunk before embedding. `\n` is decoded. */
  get documentPrefix(): string | undefined {
    return decodePrefix(process.env.OHS_DOCUMENT_PREFIX);
  },
  get localModel(): string {
    return process.env.LOCAL_EMBEDDING_MODEL ?? 'Xenova/multilingual-e5-small';
  },
  get rerankerModel(): string {
    return process.env.RERANKER_MODEL ?? DEFAULT_RERANKER_MODEL;
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
  debounce: 5_000,
};
