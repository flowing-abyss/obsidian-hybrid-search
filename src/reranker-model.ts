import os from 'node:os';
import path from 'node:path';
import { DEFAULT_RERANKER_MODEL } from './config.js';

export interface RerankerInput {
  text: string;
  text_pair: string;
}
export type RerankerPipeline = (
  inputs: RerankerInput[],
) => Promise<Array<Array<{ label: string; score: number }>>>;
interface Logits {
  data: Float32Array;
  dims: number[];
}
interface Model {
  (input: unknown): Promise<{ logits?: Logits }>;
}
interface Tokenizer {
  (
    queries: string[],
    options: { text_pair: string[]; padding: boolean; truncation: boolean; max_length: number },
  ): unknown;
}
interface ModelLoader {
  from_pretrained(
    name: string,
    options: { dtype: string; device: string; progress_callback?: (event: unknown) => void },
  ): Promise<Model>;
}
interface Transformers {
  env: { cacheDir: string };
  AutoTokenizer: {
    from_pretrained(
      name: string,
      options?: { progress_callback: (event: unknown) => void },
    ): Promise<Tokenizer>;
  };
  PreTrainedModel: ModelLoader;
  AutoModelForSequenceClassification: ModelLoader;
}

export async function loadRerankerModel(
  modelName: string,
  maxLength: number,
  device: 'cpu' | 'webgpu',
  progress?: (phase: 'download' | 'loading') => void,
): Promise<RerankerPipeline> {
  const { AutoTokenizer, PreTrainedModel, AutoModelForSequenceClassification, env } =
    (await import('@huggingface/transformers')) as unknown as Transformers;
  env.cacheDir = path.join(os.homedir(), '.cache', 'huggingface');
  // AutoModel delegates GTE's unknown "new" architecture to this same base class,
  // but prints a warning first. Loading it directly preserves the ONNX graph.
  const loader =
    modelName === DEFAULT_RERANKER_MODEL ? PreTrainedModel : AutoModelForSequenceClassification;
  let tokenizer: Tokenizer;
  let model: Model;
  if (device === 'webgpu') {
    // GPU routing is limited to GTE's single embedded-data ONNX artifact. Keep
    // tokenizer downloads outside native session creation so concurrent file
    // completion cannot shorten another download's budget or extend a GPU hang.
    progress?.('download');
    model = await loader.from_pretrained(modelName, {
      dtype: 'fp16',
      device,
      progress_callback: (raw) => {
        const event = raw as { status?: string; file?: string };
        if (event.status === 'done' && event.file?.endsWith('.onnx')) progress?.('loading');
        else if (['initiate', 'download', 'progress'].includes(event.status ?? ''))
          progress?.('download');
      },
    });
    progress?.('download');
    tokenizer = await AutoTokenizer.from_pretrained(modelName, {
      progress_callback: () => progress?.('download'),
    });
  } else {
    [tokenizer, model] = await Promise.all([
      AutoTokenizer.from_pretrained(modelName),
      loader.from_pretrained(modelName, { dtype: 'int8', device }),
    ]);
  }
  return async (inputs) => {
    const encoded = tokenizer(
      inputs.map((c) => c.text),
      {
        text_pair: inputs.map((c) => c.text_pair),
        padding: true,
        truncation: true,
        max_length: maxLength,
      },
    );
    const { logits } = await model(encoded);
    if (
      !logits ||
      (modelName === DEFAULT_RERANKER_MODEL &&
        (!Array.isArray(logits.dims) ||
          logits.dims.length !== 2 ||
          logits.dims[0] !== inputs.length ||
          logits.dims[1] !== 1 ||
          !logits.data ||
          logits.data.length !== inputs.length ||
          !Array.from(logits.data).every(Number.isFinite)))
    )
      throw new Error('Reranker returned invalid logits');
    const numLabels = logits.dims[1] ?? 1;
    return inputs.map((_, i) => [
      { label: 'LABEL_1', score: logits.data[i * numLabels + numLabels - 1] ?? 0 },
    ]);
  };
}
