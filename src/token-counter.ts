import { Tiktoken } from 'js-tiktoken/lite';
import cl100kBase from 'js-tiktoken/ranks/cl100k_base';
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

let cl100kTokenizer: Tiktoken | undefined;

function getCl100kTokenizer(): Tiktoken {
  cl100kTokenizer ??= new Tiktoken(cl100kBase);
  return cl100kTokenizer;
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

export function createOpenAiTokenCounter(model: string): TokenCounter | undefined {
  if (!OPENAI_EMBEDDING_MODELS.has(canonicalizeOpenAiEmbeddingModel(model))) return undefined;

  return {
    exact: true,
    count: (text) => getCl100kTokenizer().encode(text).length,
  };
}

export function createEstimatedTokenCounter(): TokenCounter {
  return {
    exact: false,
    count: estimateTokens,
  };
}
