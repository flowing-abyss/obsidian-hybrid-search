import { describe, expect, it } from 'vitest';
import { ResultCache } from '../src/search/result-cache.js';
import type { SearchResult } from '../src/search/searcher.js';

function result(snippet = ''): SearchResult {
  return {
    path: 'note.md',
    title: 'Note',
    snippet,
    score: 1,
    tags: [],
    aliases: [],
    matchedBy: [],
    links: [],
    backlinks: [],
    markdownLinks: [],
    markdownBacklinks: [],
    urls: [],
    scores: { semantic: null, bm25: 1, fuzzy_title: null, hybrid: null },
  };
}

describe('result cache retention and isolation', () => {
  it('evicts the least recently used entry when the count is exhausted', () => {
    const cache = new ResultCache(2);
    cache.set('a', [result()]);
    cache.set('b', [result()]);
    expect(cache.get('a')).toHaveLength(1);
    cache.set('c', [result()]);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toHaveLength(1);
    expect(cache.get('c')).toHaveLength(1);
  });

  it('evicts large entries by payload budget before reaching the count cap', () => {
    const cache = new ResultCache(100, 3000);
    cache.set('a', [result('x'.repeat(1000))]);
    cache.set('b', [result('y'.repeat(1000))]);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')?.[0]?.snippet).toHaveLength(1000);
    cache.set('oversized', [result('z'.repeat(10_000))]);
    expect(cache.get('oversized')).toBeUndefined();
    expect(cache.get('b')).toHaveLength(1);
  });

  it('accounts for dense graph metadata, not just snippets', () => {
    const cache = new ResultCache(100, 3000);
    const linked = result();
    linked.links = Array.from({ length: 200 }, (_, i) => `note-${i}.md`);
    cache.set('graph', [linked]);
    expect(cache.get('graph')).toBeUndefined();
  });

  it('isolates both inserted and returned nested values', () => {
    const cache = new ResultCache();
    const input = [result()];
    cache.set('a', input);
    input[0]!.links.push('outside.md');
    input[0]!.scores.bm25 = 0;
    const first = cache.get('a')!;
    expect(first[0]!.links).toEqual([]);
    expect(first[0]!.scores.bm25).toBe(1);
    first[0]!.tags.push('mutated');
    first.pop();
    expect(cache.get('a')).toEqual([result()]);
  });

  it('releases the old payload budget on replacement and caches empty answers', () => {
    const cache = new ResultCache(100, 3000);
    cache.set('a', [result('x'.repeat(1000))]);
    expect(cache.get('a')?.[0]?.snippet).toHaveLength(1000);
    cache.set('a', []);
    cache.set('b', [result('y'.repeat(1000))]);
    expect(cache.get('a')).toEqual([]);
    expect(cache.get('b')).toHaveLength(1);
  });
});
