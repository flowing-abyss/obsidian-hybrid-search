import assert from 'node:assert/strict';
import { afterEach, describe, it, vi } from 'vitest';
import { estimateTokens } from '../src/chunker.js';
import {
  createEstimatedTokenCounter,
  createOpenAiTokenCounter,
  effectiveTokenLimit,
  normalizeKnownModelName,
} from '../src/token-counter.js';

describe('token counters', () => {
  afterEach(() => {
    vi.doUnmock('js-tiktoken/lite');
    vi.doUnmock('js-tiktoken/ranks/cl100k_base');
  });

  it('counts OpenAI embedding tokens exactly for canonical and routed model names', async () => {
    const small = await createOpenAiTokenCounter('text-embedding-3-small');
    const routed = await createOpenAiTokenCounter('openai/text-embedding-3-small');

    assert.ok(small?.exact);
    assert.equal(small.count('tiktoken is great!'), 6);
    assert.equal(routed?.count('tiktoken is great!'), 6);
  });

  it('uses exact tokenization for text that defeats the heuristic', async () => {
    const small = await createOpenAiTokenCounter('text-embedding-3-small');
    assert.ok(small);
    const url =
      '<https://example.com/?next=' + '%2Fprivate%2Fpath%3Fa%3D1%26b%3D2'.repeat(400) + '>';

    assert.ok(small.count(url) > estimateTokens(url));
  });

  it('reserves bounded headroom from model context limits', () => {
    assert.equal(effectiveTokenLimit(8192), 8128);
    assert.equal(effectiveTokenLimit(512), 506);
  });

  it('normalizes only the final Ollama tag suffix', () => {
    assert.equal(normalizeKnownModelName('bge-m3:latest'), 'bge-m3');
    assert.equal(
      normalizeKnownModelName('registry:5000/team/model:Q8_0'),
      'registry:5000/team/model',
    );
  });

  it('does not create an exact counter for unknown models', async () => {
    assert.equal(await createOpenAiTokenCounter('bge-m3'), undefined);
    assert.equal(await createOpenAiTokenCounter('text-embedding-3-small:latest'), undefined);
  });

  it('delegates estimated counts to the existing heuristic', () => {
    const counter = createEstimatedTokenCounter();
    const text = 'Estimated token count';

    assert.equal(counter.exact, false);
    assert.equal(counter.count(text), estimateTokens(text));
  });

  it('does not load cl100k ranks for an unknown model', async () => {
    let rankLoads = 0;
    vi.doMock('js-tiktoken/ranks/cl100k_base', () => {
      rankLoads++;
      return { default: {} };
    });
    vi.resetModules();
    const fresh = await import('../src/token-counter.js');

    assert.equal(await fresh.createOpenAiTokenCounter('bge-m3'), undefined);
    assert.equal(rankLoads, 0);
  });

  it('does not cache a failed tokenizer constructor', async () => {
    let constructorCalls = 0;
    vi.doMock('js-tiktoken/lite', () => ({
      Tiktoken: class {
        constructor() {
          constructorCalls++;
          if (constructorCalls === 1) throw new Error('corrupt cl100k ranks');
        }

        encode(): number[] {
          return [1, 2, 3];
        }
      },
    }));
    vi.doMock('js-tiktoken/ranks/cl100k_base', () => ({ default: {} }));
    vi.resetModules();
    const fresh = await import('../src/token-counter.js');

    await assert.rejects(
      fresh.createOpenAiTokenCounter('text-embedding-3-small'),
      /corrupt cl100k ranks/,
    );
    const counter = await fresh.createOpenAiTokenCounter('text-embedding-3-small');

    assert.equal(constructorCalls, 2);
    assert.equal(counter?.count('retry succeeds'), 3);
  });
});
