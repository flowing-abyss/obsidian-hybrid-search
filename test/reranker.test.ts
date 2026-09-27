import assert from 'node:assert/strict';
import { afterEach, describe, it, vi } from 'vitest';

// Set vault path before any imports that read config
process.env.OBSIDIAN_VAULT_PATH = '/tmp/ohs-reranker-test';
delete process.env.RERANKER_MODEL;

vi.mock('@huggingface/transformers', () => ({
  env: { cacheDir: '' },
  AutoTokenizer: {
    from_pretrained: vi.fn().mockResolvedValue(
      // Mock tokenizer function
      vi.fn().mockReturnValue({ __encoded: true }),
    ),
  },
  AutoModelForSequenceClassification: {
    from_pretrained: vi.fn().mockResolvedValue(
      // Mock model function — will be overridden in tests for different logits shapes
      vi.fn().mockResolvedValue({
        logits: { data: new Float32Array([0.5, 0.8]), dims: [2, 1] },
      }),
    ),
  },
  AutoModel: { from_pretrained: vi.fn() },
}));

type ScoreFn = (
  inputs: Array<{ text: string; text_pair: string }>,
) => Promise<Array<Array<{ label: string; score: number }>>>;

interface MockedSequenceClassification {
  from_pretrained: ReturnType<typeof vi.fn>;
}

async function getMockedTokenizer(): Promise<MockedSequenceClassification> {
  const transformers = (await import('@huggingface/transformers')) as unknown as {
    AutoTokenizer: MockedSequenceClassification;
  };
  return transformers.AutoTokenizer;
}

async function getMockedSequenceClassification(): Promise<MockedSequenceClassification> {
  const transformers = (await import('@huggingface/transformers')) as unknown as {
    AutoModelForSequenceClassification: MockedSequenceClassification;
  };
  return transformers.AutoModelForSequenceClassification;
}

async function getMockedAutoModel(): Promise<MockedSequenceClassification> {
  const transformers = (await import('@huggingface/transformers')) as unknown as {
    AutoModel: MockedSequenceClassification;
  };
  return transformers.AutoModel;
}

const { CrossEncoderReranker, reranker } = await import('../src/reranker.js');

// ─── Mock pipeline factory ────────────────────────────────────────────────────
// Simulates @huggingface/transformers text-classification output:
// batch input → Array<Array<{label, score}>> (one array of labels per candidate)
function makeMockPipeline(
  scoreFn: (inputIndex: number) => number,
): (inputs: unknown[], opts?: unknown) => Promise<Array<Array<{ label: string; score: number }>>> {
  // eslint-disable-next-line @typescript-eslint/require-await
  return async (inputs) =>
    inputs.map((_, i) => [
      { label: 'LABEL_0', score: 1 - scoreFn(i) },
      { label: 'LABEL_1', score: scoreFn(i) },
    ]);
}

function makeReranker(scoreFn: (i: number) => number): InstanceType<typeof CrossEncoderReranker> {
  const r = new CrossEncoderReranker('mock-model');
  // Inject mock pipeline, bypassing ensureLoaded()
  (r as unknown as Record<string, unknown>)['pipeline'] = makeMockPipeline(scoreFn);
  return r;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('CrossEncoderReranker.scoreAll', () => {
  it('returns one score per candidate in input order', async () => {
    const r = makeReranker((i) => 1 - i * 0.1);
    const candidates = [
      { title: 'A', chunkText: 'text a', snippet: '' },
      { title: 'B', chunkText: 'text b', snippet: '' },
      { title: 'C', chunkText: 'text c', snippet: '' },
    ];
    const scores = await r.scoreAll('query', candidates);
    assert.strictEqual(scores.length, 3);
    assert.ok(Math.abs((scores[0] ?? 0) - 1.0) < 0.001);
    assert.ok(Math.abs((scores[1] ?? 0) - 0.9) < 0.001);
    assert.ok(Math.abs((scores[2] ?? 0) - 0.8) < 0.001);
  });

  it('uses chunkText when available, falls back to snippet', async () => {
    const seenTexts: string[] = [];
    const r = new CrossEncoderReranker('mock-model');
    (r as unknown as Record<string, unknown>)['pipeline'] =
      // eslint-disable-next-line @typescript-eslint/require-await
      async (inputs: Array<{ text: string; text_pair: string }>) => {
        seenTexts.push(...inputs.map((x) => x.text_pair));
        return inputs.map(() => [
          { label: 'LABEL_0', score: 0.1 },
          { label: 'LABEL_1', score: 0.9 },
        ]);
      };
    await r.scoreAll('q', [
      { title: 'T1', chunkText: 'chunk text', snippet: 'snippet text' },
      { title: 'T2', chunkText: undefined, snippet: 'fallback snippet' },
    ]);
    assert.ok(seenTexts[0]?.includes('chunk text'), 'chunkText should be used when present');
    assert.ok(
      seenTexts[1]?.includes('fallback snippet'),
      'snippet should be used when chunkText absent',
    );
  });

  it('text_pair includes title and content separated by newlines', async () => {
    const seenPairs: string[] = [];
    const r = new CrossEncoderReranker('mock-model');
    (r as unknown as Record<string, unknown>)['pipeline'] =
      // eslint-disable-next-line @typescript-eslint/require-await
      async (inputs: Array<{ text: string; text_pair: string }>) => {
        seenPairs.push(...inputs.map((x) => x.text_pair));
        return inputs.map(() => [
          { label: 'LABEL_0', score: 0.1 },
          { label: 'LABEL_1', score: 0.9 },
        ]);
      };
    await r.scoreAll('q', [{ title: 'My Title', chunkText: 'chunk body', snippet: '' }]);
    assert.ok(seenPairs[0]?.startsWith('My Title\n\n'), 'text_pair should start with title');
    assert.ok(seenPairs[0]?.includes('chunk body'), 'text_pair should include content');
  });

  it('returns zeros when pipeline throws (graceful fallback)', async () => {
    const r = new CrossEncoderReranker('mock-model');
    // eslint-disable-next-line @typescript-eslint/require-await
    (r as unknown as Record<string, unknown>)['pipeline'] = async () => {
      throw new Error('pipeline exploded');
    };
    const candidates = [
      { title: 'A', chunkText: 'x', snippet: '' },
      { title: 'B', chunkText: 'y', snippet: '' },
    ];
    const scores = await r.scoreAll('q', candidates);
    assert.strictEqual(scores.length, 2);
    assert.strictEqual(scores[0], 0);
    assert.strictEqual(scores[1], 0);
  });

  it('handles empty candidates array', async () => {
    const r = makeReranker(() => 0.5);
    const scores = await r.scoreAll('q', []);
    assert.deepEqual(scores, []);
  });

  it('processes candidates in batches of 4', async () => {
    const callCount = { value: 0 };
    const r = new CrossEncoderReranker('mock-model');
    (r as unknown as Record<string, unknown>)['pipeline'] =
      // eslint-disable-next-line @typescript-eslint/require-await
      async (inputs: unknown[]) => {
        callCount.value++;
        return inputs.map(() => [
          { label: 'LABEL_0', score: 0.1 },
          { label: 'LABEL_1', score: 0.9 },
        ]);
      };
    const candidates = Array.from({ length: 9 }, (_, i) => ({
      title: `C${i}`,
      chunkText: `text ${i}`,
      snippet: '',
    }));
    const scores = await r.scoreAll('q', candidates);
    assert.strictEqual(scores.length, 9);
    assert.strictEqual(
      callCount.value,
      3,
      'should make 3 calls for 9 candidates with batch size 4',
    );
    for (const s of scores) {
      assert.ok(Math.abs(s - 0.9) < 0.001);
    }
  });

  it('falls back to 0 when LABEL_1 is missing from output', async () => {
    const r = new CrossEncoderReranker('mock-model');
    (r as unknown as Record<string, unknown>)['pipeline'] =
      // eslint-disable-next-line @typescript-eslint/require-await
      async (_inputs: unknown[]) => {
        return [[{ label: 'LABEL_0', score: 0.2 }], [{ label: 'LABEL_1', score: 0.8 }]];
      };
    const candidates = [
      { title: 'A', chunkText: 'x', snippet: '' },
      { title: 'B', chunkText: 'y', snippet: '' },
    ];
    const scores = await r.scoreAll('q', candidates);
    assert.strictEqual(scores[0], 0, 'should fallback to 0 when LABEL_1 is absent');
    assert.ok(Math.abs((scores[1] ?? 0) - 0.8) < 0.001);
  });
});

describe('CrossEncoderReranker.ensureLoaded deduplication', () => {
  it('concurrent calls to ensureLoaded load the model only once', async () => {
    let loadCount = 0;
    const r = new CrossEncoderReranker('mock-model');

    // Override: simulate slow load
    (r as unknown as Record<string, unknown>)['_loadModel'] = async () => {
      loadCount++;
      await new Promise((res) => setTimeout(res, 10));
      return makeMockPipeline(() => 0.5);
    };

    // Trigger two concurrent loads
    const [s1, s2] = await Promise.all([
      r.scoreAll('q', [{ title: 'X', chunkText: 'x', snippet: '' }]),
      r.scoreAll('q', [{ title: 'Y', chunkText: 'y', snippet: '' }]),
    ]);
    assert.ok(Array.isArray(s1));
    assert.ok(Array.isArray(s2));
    assert.strictEqual(loadCount, 1, 'model should be loaded exactly once');
  });
});

describe('CrossEncoderReranker._loadModel', () => {
  afterEach(() => vi.restoreAllMocks());

  it('forwards query and document pairs with padding, truncation, and the default 128-token cap', async () => {
    const AutoTokenizer = await getMockedTokenizer();
    const AutoModelForSequenceClassification = await getMockedSequenceClassification();
    const tokenizerFn = vi.fn().mockReturnValue({ __encoded: true });
    AutoTokenizer.from_pretrained.mockResolvedValue(tokenizerFn);
    AutoModelForSequenceClassification.from_pretrained.mockClear();

    const r = new CrossEncoderReranker('onnx-community/bge-reranker-v2-m3-ONNX');
    const scoreFn = await (r as unknown as { _loadModel: () => Promise<unknown> })._loadModel();
    await (scoreFn as ScoreFn)([
      { text: 'first query', text_pair: 'first document' },
      { text: 'second query', text_pair: 'second document' },
    ]);

    assert.deepStrictEqual(tokenizerFn.mock.calls, [
      [
        ['first query', 'second query'],
        {
          text_pair: ['first document', 'second document'],
          padding: true,
          truncation: true,
          max_length: 128,
        },
      ],
    ]);
    assert.deepStrictEqual(AutoModelForSequenceClassification.from_pretrained.mock.calls, [
      ['onnx-community/bge-reranker-v2-m3-ONNX', { dtype: 'int8', device: 'cpu' }],
    ]);
  });

  it.each([256, 512])('passes an explicit %i-token cap to the tokenizer', async (maxLength) => {
    const AutoTokenizer = await getMockedTokenizer();
    const tokenizerFn = vi.fn().mockReturnValue({ __encoded: true });
    AutoTokenizer.from_pretrained.mockResolvedValue(tokenizerFn);

    const r = new CrossEncoderReranker('test-model', maxLength);
    const scoreFn = await (r as unknown as { _loadModel: () => Promise<unknown> })._loadModel();
    await (scoreFn as ScoreFn)([{ text: 'query', text_pair: 'document' }]);

    assert.deepStrictEqual(tokenizerFn.mock.calls, [
      [
        ['query'],
        { text_pair: ['document'], padding: true, truncation: true, max_length: maxLength },
      ],
    ]);
  });

  it('returns a scoring function that extracts single-label logits', async () => {
    const AutoModelForSequenceClassification = await getMockedSequenceClassification();
    const modelFn = vi.fn().mockResolvedValue({
      logits: { data: new Float32Array([0.1, 0.9]), dims: [2, 1] },
    });
    AutoModelForSequenceClassification.from_pretrained.mockResolvedValue(modelFn);

    const r = new CrossEncoderReranker('test-model');
    const scoreFn = await (r as unknown as { _loadModel: () => Promise<unknown> })._loadModel();

    const result = await (scoreFn as ScoreFn)([
      { text: 'q1', text_pair: 'doc1' },
      { text: 'q2', text_pair: 'doc2' },
    ]);

    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0]![0]!.label, 'LABEL_1');
    assert.ok(Math.abs(result[0]![0]!.score - 0.1) < 0.001);
    assert.ok(Math.abs(result[1]![0]!.score - 0.9) < 0.001);
  });

  it('returns a scoring function that extracts last-label logits for multi-label models', async () => {
    const AutoModelForSequenceClassification = await getMockedSequenceClassification();
    const modelFn = vi.fn().mockResolvedValue({
      logits: { data: new Float32Array([0.1, 0.2, 0.3, 0.4]), dims: [2, 2] },
    });
    AutoModelForSequenceClassification.from_pretrained.mockResolvedValue(modelFn);

    const r = new CrossEncoderReranker('test-model');
    const scoreFn = await (r as unknown as { _loadModel: () => Promise<unknown> })._loadModel();

    const result = await (scoreFn as ScoreFn)([
      { text: 'q1', text_pair: 'doc1' },
      { text: 'q2', text_pair: 'doc2' },
    ]);

    assert.strictEqual(result.length, 2);
    // For batch 0, label 1 (index 1) = 0.2
    assert.ok(Math.abs(result[0]![0]!.score - 0.2) < 0.001);
    // For batch 1, label 1 (index 3) = 0.4
    assert.ok(Math.abs(result[1]![0]!.score - 0.4) < 0.001);
  });

  it('falls back to 0 when logit data is missing for an index', async () => {
    const AutoModelForSequenceClassification = await getMockedSequenceClassification();
    const modelFn = vi.fn().mockResolvedValue({
      logits: { data: new Float32Array([0.5]), dims: [2, 1] },
    });
    AutoModelForSequenceClassification.from_pretrained.mockResolvedValue(modelFn);

    const r = new CrossEncoderReranker('test-model');
    const scoreFn = await (r as unknown as { _loadModel: () => Promise<unknown> })._loadModel();

    const result = await (scoreFn as ScoreFn)([
      { text: 'q1', text_pair: 'doc1' },
      { text: 'q2', text_pair: 'doc2' },
    ]);

    assert.strictEqual(result[0]![0]!.score, 0.5);
    assert.strictEqual(result[1]![0]!.score, 0);
  });
});

describe('GTE default reranker', () => {
  it('scores paired inputs with raw GTE logits through the CPU int8 generic model', async () => {
    const AutoTokenizer = await getMockedTokenizer();
    const AutoModel = await getMockedAutoModel();
    const tokenizerFn = vi.fn().mockReturnValue({ __encoded: true });
    AutoTokenizer.from_pretrained.mockResolvedValue(tokenizerFn);
    AutoModel.from_pretrained.mockResolvedValue(
      vi.fn().mockResolvedValue({ logits: { data: new Float32Array([2, -3]), dims: [2, 1] } }),
    );

    const scores = await reranker.scoreAll('internal links', [
      { title: 'Links', snippet: 'Use internal links to connect notes' },
      { title: 'Bread', snippet: 'Bread is baked in an oven' },
    ]);

    assert.deepStrictEqual(scores, [2, -3]);
    assert.deepStrictEqual(AutoModel.from_pretrained.mock.calls, [
      ['onnx-community/gte-multilingual-reranker-base', { dtype: 'int8', device: 'cpu' }],
    ]);
    assert.deepStrictEqual(tokenizerFn.mock.calls, [
      [
        ['internal links', 'internal links'],
        {
          text_pair: [
            'Links\n\nUse internal links to connect notes',
            'Bread\n\nBread is baked in an oven',
          ],
          padding: true,
          truncation: true,
          max_length: 256,
        },
      ],
    ]);
  });

  it.each([
    { name: 'missing logits', logits: undefined },
    { name: 'wrong label count', logits: { data: new Float32Array([2, -3, 4, 5]), dims: [2, 2] } },
    { name: 'wrong batch count', logits: { data: new Float32Array([2]), dims: [1, 1] } },
    { name: 'short data', logits: { data: new Float32Array([2]), dims: [2, 1] } },
    { name: 'nonfinite data', logits: { data: new Float32Array([2, Number.NaN]), dims: [2, 1] } },
  ])('falls back when GTE returns $name', async ({ logits }) => {
    const AutoModel = await getMockedAutoModel();
    AutoModel.from_pretrained.mockResolvedValue(vi.fn().mockResolvedValue({ logits }));
    const r = new CrossEncoderReranker('onnx-community/gte-multilingual-reranker-base');
    const scores = await r.scoreAll('query', [
      { title: 'A', snippet: 'first' },
      { title: 'B', snippet: 'second' },
    ]);
    assert.deepStrictEqual(scores, [0, 0]);
  });
});

describe('CrossEncoderReranker.ensureLoaded failure', () => {
  it('returns zeros when model load fails', async () => {
    const r = new CrossEncoderReranker('mock-model');
    (r as unknown as Record<string, unknown>)['_loadModel'] = () => {
      throw new Error('model load failed');
    };

    const candidates = [
      { title: 'A', chunkText: 'x', snippet: '' },
      { title: 'B', chunkText: 'y', snippet: '' },
    ];
    const scores = await r.scoreAll('q', candidates);
    assert.strictEqual(scores.length, 2);
    assert.strictEqual(scores[0], 0);
    assert.strictEqual(scores[1], 0);
  });
});
