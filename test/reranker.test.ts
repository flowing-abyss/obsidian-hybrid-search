import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

// Set vault path before any imports that read config
process.env.OBSIDIAN_VAULT_PATH = '/tmp/ohs-reranker-test';

const { CrossEncoderReranker } = await import('../src/reranker.js');

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
