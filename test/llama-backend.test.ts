import assert from 'node:assert/strict';
import { beforeEach, describe, it, vi } from 'vitest';
import type { RerankCandidate } from '../src/reranker.js';

process.env.OBSIDIAN_VAULT_PATH = '/tmp/ohs-llama-test';

// ─── Mock node-llama-cpp ──────────────────────────────────────────────────────
// Matches REAL API from spike:
// - resolveModelFile() → returns local path (no-op in tests)
// - getLlama() → { loadModel() }
// - loadModel() → { createEmbeddingContext(), createRankingContext() }
// - createEmbeddingContext() → { getEmbeddingFor() } (returns LlamaEmbedding with .vector)
// - createRankingContext() → { rank(query, doc), rankAll(query, docs) }

const mockGetEmbeddingFor = vi.fn().mockResolvedValue({ vector: [0.1, 0.2, 0.3] }); // LlamaEmbedding shape
const mockCreateEmbeddingContext = vi.fn().mockResolvedValue({
  getEmbeddingFor: mockGetEmbeddingFor,
  dispose: vi.fn(),
});

const mockRank = vi.fn().mockResolvedValue(0.9);
const mockRankAll = vi.fn().mockResolvedValue([0.9, 0.5]);
const mockCreateRankingContext = vi.fn().mockResolvedValue({
  rank: mockRank,
  rankAll: mockRankAll,
  dispose: vi.fn(),
});

const mockLoadModel = vi.fn().mockResolvedValue({
  createEmbeddingContext: mockCreateEmbeddingContext,
  createRankingContext: mockCreateRankingContext,
});
const mockGetLlama = vi.fn().mockResolvedValue({
  loadModel: mockLoadModel,
});
const mockResolveModelFile = vi.fn().mockResolvedValue('/tmp/fake-model.gguf');

vi.mock('node-llama-cpp', () => ({
  getLlama: mockGetLlama,
  resolveModelFile: mockResolveModelFile,
  LlamaLogLevel: { disabled: 0, fatal: 1, error: 2, warn: 3, info: 4, log: 5, debug: 6 },
}));

// node-llama-cpp is dynamically imported inside llama-backend.ts (not at module
// load time), so vi.mock above intercepts it correctly even with isolate:false.
const { llamaEmbed, llamaRerank, _resetForTest } = await import('../src/llama-backend.js');

// ─── llamaEmbed ───────────────────────────────────────────────────────────────
describe('llamaEmbed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTest();
    mockGetEmbeddingFor.mockResolvedValue({ vector: [0.1, 0.2, 0.3] });
    mockResolveModelFile.mockResolvedValue('/tmp/fake-embed-model.gguf');
    mockLoadModel.mockResolvedValue({
      createEmbeddingContext: mockCreateEmbeddingContext,
      createRankingContext: mockCreateRankingContext,
    });
    mockCreateEmbeddingContext.mockResolvedValue({
      getEmbeddingFor: mockGetEmbeddingFor,
      dispose: vi.fn(),
    });
  });

  it('returns one Float32Array per input text', async () => {
    const results = await llamaEmbed(['hello', 'world'], 'document');
    assert.strictEqual(results.length, 2);
    assert.ok(results[0] instanceof Float32Array, 'Expected Float32Array');
    assert.ok(results[1] instanceof Float32Array, 'Expected Float32Array');
  });

  it('prepends "passage: " prefix for document type', async () => {
    await llamaEmbed(['Obsidian is great'], 'document');
    const calledWith = mockGetEmbeddingFor.mock.calls[0]?.[0] as string;
    assert.ok(
      calledWith.startsWith('passage: '),
      `Expected "passage: " prefix, got: "${calledWith}"`,
    );
  });

  it('prepends "query: " prefix for query type', async () => {
    await llamaEmbed(['What is Obsidian?'], 'query');
    const calledWith = mockGetEmbeddingFor.mock.calls[0]?.[0] as string;
    assert.ok(calledWith.startsWith('query: '), `Expected "query: " prefix, got: "${calledWith}"`);
  });

  it('returns null for a text when getEmbeddingFor throws', async () => {
    mockGetEmbeddingFor.mockRejectedValueOnce(new Error('inference failed'));
    const results = await llamaEmbed(['bad text'], 'document');
    assert.strictEqual(results[0], null);
  });

  it('loads embedding model only once for concurrent calls', async () => {
    let loadCount = 0;
    mockLoadModel.mockImplementation(async () => {
      loadCount++;
      await new Promise((r) => setTimeout(r, 20));
      return {
        createEmbeddingContext: mockCreateEmbeddingContext,
        createRankingContext: mockCreateRankingContext,
      };
    });

    await Promise.all([
      llamaEmbed(['a'], 'document'),
      llamaEmbed(['b'], 'document'),
      llamaEmbed(['c'], 'document'),
    ]);

    assert.strictEqual(loadCount, 1, 'embedding model should be loaded exactly once');
  });

  it('does not load reranker model when only llamaEmbed is called', async () => {
    vi.clearAllMocks();
    _resetForTest();
    mockGetEmbeddingFor.mockResolvedValue({ vector: [0.1, 0.2, 0.3] });
    mockResolveModelFile.mockResolvedValue('/tmp/fake-model.gguf');
    let loadCallCount = 0;
    mockLoadModel.mockImplementation(async () => {
      loadCallCount++;
      return {
        createEmbeddingContext: mockCreateEmbeddingContext,
        createRankingContext: mockCreateRankingContext,
      };
    });

    await llamaEmbed(['test'], 'document');

    assert.strictEqual(
      loadCallCount,
      1,
      'only one model should be loaded (embedder, not reranker)',
    );
  });
});

// ─── llamaRerank ──────────────────────────────────────────────────────────────
describe('llamaRerank', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTest();
    mockRank.mockResolvedValue(0.9);
    mockRankAll.mockResolvedValue([0.9]);
    mockResolveModelFile.mockResolvedValue('/tmp/fake-reranker-model.gguf');
    mockLoadModel.mockResolvedValue({
      createEmbeddingContext: mockCreateEmbeddingContext,
      createRankingContext: mockCreateRankingContext,
    });
    mockCreateRankingContext.mockResolvedValue({
      rank: mockRank,
      rankAll: mockRankAll,
      dispose: vi.fn(),
    });
  });

  it('returns one score per candidate', async () => {
    const candidates: RerankCandidate[] = [
      { title: 'A', chunkText: 'text a', snippet: '' },
      { title: 'B', chunkText: 'text b', snippet: '' },
    ];
    mockRankAll.mockResolvedValue([0.9, 0.5]);
    const scores = await llamaRerank('query', candidates);
    assert.strictEqual(scores.length, 2);
    assert.ok(typeof scores[0] === 'number');
    assert.ok(typeof scores[1] === 'number');
  });

  it('returns empty array for empty candidates without calling model', async () => {
    const scores = await llamaRerank('q', []);
    assert.deepEqual(scores, []);
    assert.strictEqual(mockRankAll.mock.calls.length, 0);
  });

  it('uses chunkText when available, falls back to snippet', async () => {
    const seenDocs: string[] = [];
    mockRankAll.mockImplementation(async (_query: string, docs: string[]) => {
      seenDocs.push(...docs);
      return docs.map(() => 0.5);
    });

    await llamaRerank('q', [
      { title: 'T1', chunkText: 'chunk body', snippet: 'snippet text' },
      { title: 'T2', chunkText: undefined, snippet: 'fallback snippet' },
    ]);

    assert.ok(
      seenDocs[0]?.includes('chunk body'),
      `Expected "chunk body" in doc, got: ${seenDocs[0]}`,
    );
    assert.ok(
      seenDocs[1]?.includes('fallback snippet'),
      `Expected "fallback snippet" in doc, got: ${seenDocs[1]}`,
    );
  });

  it('includes title and content separated by double newline', async () => {
    const seenDocs: string[] = [];
    mockRankAll.mockImplementation(async (_query: string, docs: string[]) => {
      seenDocs.push(...docs);
      return docs.map(() => 0.5);
    });

    await llamaRerank('q', [{ title: 'My Title', chunkText: 'chunk body', snippet: '' }]);

    assert.ok(
      seenDocs[0]?.includes('My Title\n\nchunk body'),
      `Expected "My Title\\n\\nchunk body" in doc, got: ${seenDocs[0]}`,
    );
  });

  it('returns 0 for a candidate when rankAll throws', async () => {
    mockRankAll.mockRejectedValueOnce(new Error('reranker failed'));
    const scores = await llamaRerank('q', [{ title: 'A', chunkText: 'x', snippet: '' }]);
    assert.strictEqual(scores[0], 0);
  });
});
