import { config } from './config.js';

export interface RerankCandidate {
  title: string;
  chunkText?: string;
  snippet: string;
}

export class CrossEncoderReranker {
  private pipeline: ((inputs: unknown[], opts?: unknown) => Promise<unknown>) | null = null;
  private loadPromise: Promise<void> | null = null;

  constructor(public readonly modelName: string) {}

  /**
   * Score all candidates against the query.
   * Returns scores in the same order as the input (NOT reordered).
   * Caller is responsible for sorting and slicing.
   * Returns all-zeros on pipeline error (graceful degradation).
   */
  async scoreAll(query: string, candidates: RerankCandidate[]): Promise<number[]> {
    if (candidates.length === 0) return [];

    // Distinguish load failure from scoring failure — different user-facing messages
    try {
      await this.ensureLoaded();
    } catch (loadErr) {
      process.stderr.write(
        `Reranker model failed to load: ${loadErr instanceof Error ? loadErr.message : String(loadErr)}. Falling back to hybrid results.\n`,
      );
      return candidates.map(() => 0);
    }

    try {
      const inputs = candidates.map((c) => ({
        text: query,
        text_pair: `${c.title}\n\n${c.chunkText ?? c.snippet}`,
      }));

      // @huggingface/transformers text-classification batch output:
      // Array<Array<{label: string; score: number}>> — one array of labels per input
      // BGE reranker labels: LABEL_0 = not relevant, LABEL_1 = relevant
      // Do not cast to a concrete type — noUncheckedIndexedAccess must stay active
      const outputs: Array<Array<{ label: string; score: number }> | undefined> = (await (
        this.pipeline as (i: unknown[], o?: unknown) => Promise<unknown>
      )(inputs, {
        truncation: true,
      })) as Array<Array<{ label: string; score: number }> | undefined>;

      return candidates.map((_, i) => outputs[i]?.find((x) => x.label === 'LABEL_1')?.score ?? 0);
    } catch (err) {
      process.stderr.write(
        `Reranking failed: ${err instanceof Error ? err.message : String(err)}. Returning original order.\n`,
      );
      return candidates.map(() => 0);
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.pipeline) return;
    if (!this.loadPromise) {
      // Assign loadPromise BEFORE awaiting — prevents race where two concurrent
      // callers both see loadPromise === null and load the model twice.
      process.stderr.write(`Loading reranker model ${this.modelName}, please wait...\n`);
      this.loadPromise = this._loadModel().then((p) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- _loadModel returns any (xenova has no types)
        this.pipeline = p;
      });
    }
    await this.loadPromise;
  }

  /** Separated for testability — tests can override _loadModel to count invocations. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- @huggingface/transformers has no types
  protected async _loadModel(): Promise<any> {
    // We intentionally bypass the high-level pipeline() here. TextClassificationPipeline:
    // 1. Does not pass text_pair to the tokenizer, so pairs are never encoded together.
    // 2. Always applies softmax — useless for BGE reranker (1 output neuron → always 1.0).
    // Instead, load tokenizer + model directly and return raw logits as relevance scores.
    const { AutoTokenizer, AutoModelForSequenceClassification } =
      await import('@huggingface/transformers');
    const [tokenizer, model] = await Promise.all([
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- no types
      (AutoTokenizer as any).from_pretrained(this.modelName) as Promise<unknown>,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- no types
      (AutoModelForSequenceClassification as any).from_pretrained(this.modelName, {
        // v3 API: dtype replaces quantized:true; 'q8' = int8 quantized (32MB vs 571MB fp32)
        dtype: 'q8',
        // device:'auto' enables CoreML on Apple Silicon, CUDA on Linux GPU servers
        device: 'auto',
      }) as Promise<unknown>,
    ]);

    // Return a function with the same signature as the pipeline mock used in tests:
    // (inputs: Array<{text, text_pair}>, opts?) => Array<Array<{label, score}>>
    // LABEL_1 score = raw relevance logit (higher = more relevant, matches BGE reranker convention)
    return async (inputs: Array<{ text: string; text_pair: string }>) => {
      const queries = inputs.map((c) => c.text);
      const docs = inputs.map((c) => c.text_pair);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- no types
      const encoded = (tokenizer as any)(queries, {
        text_pair: docs,
        padding: true,
        truncation: true,
      }) as unknown;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- no types
      const { logits } = (await (model as any)(encoded)) as {
        logits: { data: Float32Array; dims: number[] };
      };
      // logits shape: [batch_size, num_labels]
      // - 1 label (bge-reranker-base/large): single regression logit
      // - 2 labels (bge-reranker-v2-m3): LABEL_0=not relevant, LABEL_1=relevant
      // Use the last label's logit as the relevance score (works for both cases)
      const numLabels = logits.dims[1] ?? 1;
      return inputs.map((_, i) => [
        { label: 'LABEL_1', score: logits.data[i * numLabels + (numLabels - 1)] ?? 0 },
      ]);
    };
  }
}

/** Module-level singleton — imported by searcher.ts */
export const reranker = new CrossEncoderReranker(config.rerankerModel);
