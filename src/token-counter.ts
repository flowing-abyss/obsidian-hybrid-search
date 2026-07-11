import { estimateTokens } from './chunker.js';

export interface TokenCounter {
  exact: boolean;
  count(text: string): number;
}

const OPENAI_EMBEDDING_MODELS = new Set([
  'text-embedding-ada-002',
  'text-embedding-3-small',
  'text-embedding-3-large',
]);

interface Encoder {
  encode(text: string): number[];
}

let cl100kTokenizerPromise: Promise<Encoder> | undefined;

function getCl100kTokenizer(): Promise<Encoder> {
  if (!cl100kTokenizerPromise) {
    const initialization = Promise.all([
      import('js-tiktoken/lite'),
      import('js-tiktoken/ranks/cl100k_base'),
    ]).then(([{ Tiktoken }, { default: cl100kBase }]) => new Tiktoken(cl100kBase));
    cl100kTokenizerPromise = initialization;
    void initialization.catch(() => {
      if (cl100kTokenizerPromise === initialization) cl100kTokenizerPromise = undefined;
    });
  }
  return cl100kTokenizerPromise;
}

export function effectiveTokenLimit(contextLength: number): number {
  const reserve = Math.min(64, Math.max(4, Math.ceil(contextLength * 0.01)));
  return Math.max(1, contextLength - reserve);
}

export function normalizeKnownModelName(model: string): string {
  const finalColon = model.lastIndexOf(':');
  const finalSlash = model.lastIndexOf('/');
  return finalColon > finalSlash ? model.slice(0, finalColon) : model;
}

function canonicalizeOpenAiEmbeddingModel(model: string): string {
  if (!model.startsWith('openai/')) return model;

  const unprefixed = model.slice('openai/'.length);
  return OPENAI_EMBEDDING_MODELS.has(unprefixed) ? unprefixed : model;
}

export async function createOpenAiTokenCounter(model: string): Promise<TokenCounter | undefined> {
  if (!OPENAI_EMBEDDING_MODELS.has(canonicalizeOpenAiEmbeddingModel(model))) return undefined;
  const tokenizer = await getCl100kTokenizer();

  return {
    exact: true,
    count: (text) => tokenizer.encode(text).length,
  };
}

export function createEstimatedTokenCounter(): TokenCounter {
  return {
    exact: false,
    count: estimateTokens,
  };
}
