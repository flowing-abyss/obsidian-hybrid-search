import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config, DEFAULT_RERANKER_MODEL } from './config.js';

export interface RerankCandidate {
  title: string;
  chunkText?: string;
  snippet: string;
}

export class CrossEncoderReranker {
  private pipeline: ((inputs: unknown[], opts?: unknown) => Promise<unknown>) | null = null;
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
      const cacheDir = path.join(os.homedir(), '.cache', 'huggingface', this.modelName);
      const isCached = fs.existsSync(cacheDir);
      if (!isCached) {
        process.stderr.write(`Loading reranker model ${this.modelName}, please wait...\n`);
      }
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
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { AutoTokenizer, AutoModel, AutoModelForSequenceClassification, env } =
      await import('@huggingface/transformers');
    // Redirect cache to ~/.cache/huggingface so models survive npm install / node_modules wipes.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    env.cacheDir = path.join(os.homedir(), '.cache', 'huggingface');
    // Transformers.js lacks a sequence-classification mapping for GTE's model_type="new";
    // AutoModel runs its ONNX classifier graph through the generic model path.
    const modelLoader = (this.modelName === DEFAULT_RERANKER_MODEL
      ? AutoModel
      : AutoModelForSequenceClassification) as unknown as {
      from_pretrained: (
        modelName: string,
        options: { dtype: string; device: string },
      ) => Promise<unknown>;
    };
    const [tokenizer, model] = await Promise.all([
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unnecessary-type-assertion -- no types
      (AutoTokenizer as any).from_pretrained(this.modelName) as Promise<unknown>,
      modelLoader.from_pretrained(this.modelName, {
        // Keep both model paths on the portable CPU/int8 ONNX runtime.
        dtype: 'int8',
        device: 'cpu',
      }),
    ]);

    // Return a function with the same signature as the pipeline mock used in tests:
    // (inputs: Array<{text, text_pair}>, opts?) => Array<Array<{label, score}>>
    // LABEL_1 is our adapter's raw relevance score; higher means more relevant.
    return async (inputs: Array<{ text: string; text_pair: string }>) => {
      const queries = inputs.map((c) => c.text);
      const docs = inputs.map((c) => c.text_pair);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any -- no types
      const encoded = (tokenizer as any)(queries, {
        text_pair: docs,
        padding: true,
        truncation: true,
        // GTE defaults to 256 tokens; BGE/custom models default to 128, with constructor overrides.
        max_length: this.maxLength,
      }) as unknown;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any -- no types
      const { logits } = (await (model as any)(encoded)) as {
        logits: { data: Float32Array; dims: number[] };
      };
      if (this.modelName === DEFAULT_RERANKER_MODEL) {
        if (
          !logits ||
          !Array.isArray(logits.dims) ||
          logits.dims.length !== 2 ||
          logits.dims[0] !== inputs.length ||
          logits.dims[1] !== 1 ||
          !logits.data ||
          logits.data.length !== inputs.length ||
          !Array.from(logits.data).every(Number.isFinite)
        ) {
          throw new Error('GTE reranker returned invalid logits');
        }
      }
      // logits shape: [batch_size, num_labels]
      // The current GTE and BGE artifacts have one relevance logit per pair.
      // Keep the last-label convention for custom two-label classifiers.
      const numLabels = logits.dims[1] ?? 1;
      return inputs.map((_, i) => [
        { label: 'LABEL_1', score: logits.data[i * numLabels + (numLabels - 1)] ?? 0 },
      ]);
    };
  }
}

/** Module-level singleton — imported by searcher.ts */
export const reranker = new CrossEncoderReranker(config.rerankerModel);
