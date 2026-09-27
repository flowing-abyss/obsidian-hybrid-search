import { config, DEFAULT_RERANKER_MODEL } from './config.js';
import { RerankerDevice } from './reranker-device.js';
import { loadRerankerModel, type RerankerPipeline } from './reranker-model.js';

export interface RerankCandidate {
  title: string;
  chunkText?: string;
  snippet: string;
}

export class CrossEncoderReranker {
  private pipeline: RerankerPipeline | null = null;
  private device: RerankerDevice | null = null;
  private loadPromise: Promise<void> | null = null;

  constructor(
    public readonly modelName: string,
    private readonly maxLength = modelName === DEFAULT_RERANKER_MODEL ? 256 : 128,
  ) {}

  /**
   * Score all candidates against the query.
   * Returns scores in the same order as the input (NOT reordered).
   * Caller is responsible for sorting and slicing.
   * Returns all-zeros on pipeline error (graceful degradation).
   */
  async scoreAll(query: string, candidates: RerankCandidate[]): Promise<number[]> {
    if (candidates.length === 0) return [];

    try {
      if (this.modelName === DEFAULT_RERANKER_MODEL) {
        this.device ??= new RerankerDevice(this.modelName, this.maxLength);
        return await this.device.scoreAll(query, candidates, () =>
          this.scoreCpu(query, candidates),
        );
      }
      return await this.scoreCpu(query, candidates);
    } catch {
      return candidates.map(() => 0);
    }
  }

  private async scoreCpu(query: string, candidates: RerankCandidate[]): Promise<number[]> {
    await this.ensureLoaded();
    try {
      const inputs = candidates.map((c) => ({
        text: query,
        text_pair: `${c.title}\n\n${c.chunkText ?? c.snippet}`,
      }));

      // Process in sub-batches of four to bound peak attention memory.
      const BATCH_SIZE = 4;
      const outputs: Array<Array<{ label: string; score: number }> | undefined> = [];
      for (let i = 0; i < inputs.length; i += BATCH_SIZE) {
        const batch = inputs.slice(i, i + BATCH_SIZE);
        // Our model adapter returns one label/score array per input.
        // LABEL_1 carries the raw relevance logit for both model paths.
        // Do not cast to a concrete type — noUncheckedIndexedAccess must stay active
        const batchOutputs = (await (
          this.pipeline as (i: unknown[], o?: unknown) => Promise<unknown>
        )(batch, {
          truncation: true,
        })) as Array<Array<{ label: string; score: number }> | undefined>;
        outputs.push(...batchOutputs);
      }

      return candidates.map((_, i) => outputs[i]?.find((x) => x.label === 'LABEL_1')?.score ?? 0);
    } catch {
      return candidates.map(() => 0);
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.pipeline) return;
    if (!this.loadPromise) {
      // Assign loadPromise BEFORE awaiting — prevents race where two concurrent
      // callers both see loadPromise === null and load the model twice.
      this.loadPromise = this._loadModel().then((p) => {
        this.pipeline = p;
      });
    }
    await this.loadPromise;
  }

  protected _loadModel(): Promise<RerankerPipeline> {
    return loadRerankerModel(this.modelName, this.maxLength, 'cpu');
  }
}

/** Module-level singleton imported by searcher.ts. */
export const reranker = new CrossEncoderReranker(config.rerankerModel);
