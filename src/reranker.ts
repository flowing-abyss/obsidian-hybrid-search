import { llamaRerank } from './llama-backend.js';
import type { RerankCandidate } from './reranker-types.js';

export type { RerankCandidate } from './reranker-types.js';

export class CrossEncoderReranker {
  constructor() {}

  /**
   * Score all candidates against the query.
   * Returns scores in the same order as the input (NOT reordered).
   * Caller is responsible for sorting and slicing.
   * Returns all-zeros on error (graceful degradation).
   */
  async scoreAll(query: string, candidates: RerankCandidate[]): Promise<number[]> {
    if (candidates.length === 0) return [];
    try {
      return await llamaRerank(query, candidates);
    } catch (err) {
      process.stderr.write(
        `Reranking failed: ${err instanceof Error ? err.message : String(err)}. Returning original order.\n`,
      );
      return candidates.map(() => 0);
    }
  }
}

/** Module-level singleton — imported by searcher.ts */
export const reranker = new CrossEncoderReranker();
