import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { estimateTokens } from '../src/chunker.js';
import {
  createEstimatedTokenCounter,
  createOpenAiTokenCounter,
  effectiveTokenLimit,
  normalizeKnownModelName,
} from '../src/token-counter.js';

describe('token counters', () => {
  it('counts OpenAI embedding tokens exactly for canonical and routed model names', () => {
    const small = createOpenAiTokenCounter('text-embedding-3-small');
    const routed = createOpenAiTokenCounter('openai/text-embedding-3-small');

    assert.ok(small?.exact);
    assert.equal(small.count('tiktoken is great!'), 6);
    assert.equal(routed?.count('tiktoken is great!'), 6);
  });

  it('uses exact tokenization for text that defeats the heuristic', () => {
    const small = createOpenAiTokenCounter('text-embedding-3-small');
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

  it('does not create an exact counter for unknown models', () => {
    assert.equal(createOpenAiTokenCounter('bge-m3'), undefined);
    assert.equal(createOpenAiTokenCounter('text-embedding-3-small:latest'), undefined);
  });

  it('delegates estimated counts to the existing heuristic', () => {
    const counter = createEstimatedTokenCounter();
    const text = 'Estimated token count';

    assert.equal(counter.exact, false);
    assert.equal(counter.count(text), estimateTokens(text));
  });
});
