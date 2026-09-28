// Model I/O boundary for CLI output-contract tests. The CLI, parser and DB are real.
import type { ResolveHook } from 'node:module';
const model = `
export const env = { logLevel: 30 };
export const LogLevel = { ERROR: 40 };
async function download(name, options) {
  const emit = (event) => options.progress_callback?.({ name, file: 'uncached-test-model.onnx', ...event });
  emit({ status: 'initiate' });
  emit({ status: 'download' });
  emit({ status: 'progress', loaded: 50, total: 100, progress: 50 });
  await new Promise(resolve => setTimeout(resolve, 250));
  emit({ status: 'done' });
}
export async function pipeline(_task, name, options) {
  await download(name, options);
  return Object.assign(async () => ({ data: new Float32Array([1, 0]) }), {
    tokenizer: { model_max_length: 512, encode: () => [1, 2] },
    model: { config: { max_position_embeddings: 512 } },
  });
}
export const AutoTokenizer = {
  async from_pretrained(name, options) {
    await download(name, options);
    return queries => ({ count: queries.length });
  },
};
export const AutoModelForSequenceClassification = {
  async from_pretrained(name, options) {
    await download(name, options);
    return async ({count}) => ({ logits: { data: new Float32Array(count).fill(2), dims: [count, 1] } });
  },
};
`;

export const resolve: ResolveHook = (specifier, context, nextResolve) => {
  if (specifier === '@huggingface/transformers') {
    return { url: `data:text/javascript,${encodeURIComponent(model)}`, shortCircuit: true };
  }
  return nextResolve(specifier, context);
};
