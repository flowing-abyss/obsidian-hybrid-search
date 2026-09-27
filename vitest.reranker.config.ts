import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/reranker-real-model.test.ts'],
    testTimeout: 600_000,
  },
});
