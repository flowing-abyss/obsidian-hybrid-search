import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

delete process.env.RERANKER_MODEL;
delete process.env.OPENAI_API_KEY;
delete process.env.OPENAI_BASE_URL;

const { reranker } = await import('../src/reranker.js');

const cases = [
  {
    name: 'English query and English documents, including a second batch',
    query: 'How do internal links connect notes?',
    relevant: 'Internal links connect related notes in a knowledge base.',
    distractors: [
      'Bread is baked in an oven.',
      'The weather forecast predicts rain tomorrow.',
      'A bicycle needs its tires inflated.',
      'The orchestra rehearsed a symphony.',
      'Coffee beans are roasted before brewing.',
    ],
  },
  {
    name: 'Russian query and English documents',
    query: 'Как связать заметки внутренними ссылками?',
    relevant: 'Use internal links to connect related notes.',
    distractors: ['Bread is baked in an oven.', 'The train leaves at noon.'],
  },
  {
    name: 'Chinese query and English documents',
    query: '如何使用内部链接连接笔记？',
    relevant: 'Use internal links to connect related notes.',
    distractors: ['Bread is baked in an oven.', 'The train leaves at noon.'],
  },
  {
    name: 'Chinese query and Chinese documents',
    query: '如何使用内部链接连接笔记？',
    relevant: '使用内部链接连接相关笔记。',
    distractors: ['面包是在烤箱里烤的。', '火车中午出发。'],
  },
] as const;

describe('default real GTE reranker', () => {
  it.each(cases)('$name', async ({ query, relevant, distractors }) => {
    const candidates = [relevant, ...distractors].map((snippet, index) => ({
      title: `Document ${index}`,
      snippet,
    }));
    const scores = await reranker.scoreAll(query, candidates);

    assert.strictEqual(scores.length, candidates.length);
    assert.ok(scores.every(Number.isFinite), 'all scores must be finite');
    assert.ok(new Set(scores).size > 1, 'scores must vary across documents');
    assert.ok(scores[0]! > Math.max(...scores.slice(1)), 'relevant document must rank first');
  });
});
