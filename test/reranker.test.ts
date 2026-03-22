import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CrossEncoderReranker } from '../src/reranker.js';

vi.mock('../src/llama-backend.js', () => ({
  llamaRerank: vi.fn(),
}));

describe('CrossEncoderReranker', () => {
  let reranker: CrossEncoderReranker;
  let mockLlamaRerank: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../src/llama-backend.js');
    mockLlamaRerank = mod.llamaRerank as ReturnType<typeof vi.fn>;
    reranker = new CrossEncoderReranker();
  });

  it('returns empty array for empty candidates', async () => {
    const scores = await reranker.scoreAll('query', []);
    expect(scores).toEqual([]);
  });

  it('delegates to llamaRerank and returns scores', async () => {
    mockLlamaRerank.mockResolvedValue([0.9, 0.1]);
    const candidates = [
      { title: 'A', snippet: 'hello' },
      { title: 'B', snippet: 'world' },
    ];
    const scores = await reranker.scoreAll('query', candidates);
    expect(mockLlamaRerank).toHaveBeenCalledOnce();
    expect(scores).toEqual([0.9, 0.1]);
  });

  it('returns zeros on llamaRerank failure', async () => {
    mockLlamaRerank.mockRejectedValue(new Error('GPU error'));
    const candidates = [
      { title: 'A', snippet: 'hello' },
      { title: 'B', snippet: 'world' },
    ];
    const scores = await reranker.scoreAll('query', candidates);
    expect(scores).toEqual([0, 0]);
  });
});
