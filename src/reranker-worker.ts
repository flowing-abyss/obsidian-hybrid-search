import type { WorkerRequest } from './reranker-gpu.js';
import { loadRerankerModel, type RerankerPipeline } from './reranker-model.js';
import { inspectLinuxGpu } from './reranker-platform.js';

// ONNX IR8/opset13: float32 inputs -> Cast(float16) -> MatMul -> Cast(float32).
// Float32 I/O avoids Node versions with incomplete native Float16Array support.
// Inputs are runtime tensors, so graph optimization cannot replace GPU computation.
const PROBE_MODEL = Buffer.from(
  'CAg6tgEKGAoBYRICYWgiBENhc3QqCQoCdG8YCqABAgoYCgFiEgJiaCIEQ2FzdCoJCgJ0bxgKoAECChQKAmFoCgJiaBICeWgiBk1hdE11bAoYCgJ5aBIBeSIEQ2FzdCoJCgJ0bxgBoAECEhF3ZWJncHUtZnAxNi1wcm9iZVoTCgFhEg4KDAgBEggKAggCCgIIAloTCgFiEg4KDAgBEggKAggCCgIIAmITCgF5Eg4KDAgBEggKAggCCgIIAkICEA0=',
  'base64',
);

async function probe(): Promise<boolean> {
  if (process.platform === 'linux' && !inspectLinuxGpu().physical) return false;
  const ort = await import('onnxruntime-node');
  if (!ort.listSupportedBackends().some((backend) => backend.name === 'webgpu' && backend.bundled))
    return false;
  const session = await ort.InferenceSession.create(PROBE_MODEL, {
    executionProviders: ['webgpu'],
    logSeverityLevel: 4,
    extra: { session: { disable_cpu_ep_fallback: '1' } },
  });
  try {
    const expected = [2, 3, 4, 5];
    const output = await session.run({
      a: new ort.Tensor('float32', Float32Array.from([1, 0, 0, 1]), [2, 2]),
      b: new ort.Tensor('float32', Float32Array.from(expected), [2, 2]),
    });
    const data = output.y?.data;
    return (
      data instanceof Float32Array &&
      data.length === 4 &&
      expected.every((value, i) => data[i] === value)
    );
  } finally {
    await session.release();
  }
}

let pipeline: RerankerPipeline | undefined;
async function execute(message: WorkerRequest): Promise<unknown> {
  if (message.type === 'probe') return probe();
  if (message.type === 'load') {
    pipeline = await loadRerankerModel(
      message.modelName,
      message.maxLength,
      'webgpu',
      (progress) => {
        process.send?.({ id: message.id, progress });
      },
      (download) => {
        process.send?.({ id: message.id, download });
      },
    );
    return true;
  }
  if (!pipeline || !message.candidates || typeof message.query !== 'string')
    throw new Error('Worker not loaded');
  const inputs = message.candidates.map((candidate) => ({
    text: message.query!,
    text_pair: `${candidate.title}\n\n${candidate.chunkText ?? candidate.snippet}`,
  }));
  const scores: number[] = [];
  for (let offset = 0; offset < inputs.length; offset += 4) {
    const result = await pipeline(inputs.slice(offset, offset + 4));
    scores.push(
      ...result.map(
        (labels) => labels.find((label) => label.label === 'LABEL_1')?.score ?? Number.NaN,
      ),
    );
  }
  return scores;
}

// Idle children do not outlive their CLI/MCP parent.
process.once('disconnect', () => process.exit(0));
process.on('message', (message: WorkerRequest) => {
  void execute(message).then(
    (value) => {
      process.send?.({ id: message.id, ok: true, value });
    },
    () => {
      process.send?.({ id: message.id, ok: false });
    },
  );
});
