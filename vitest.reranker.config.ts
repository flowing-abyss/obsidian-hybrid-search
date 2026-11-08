import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/setup-vault-environment.ts'],
    include: ['test/reranker-real-model.test.ts'],
    testTimeout: 600_000,
  },
});
