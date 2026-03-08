import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/integration.test.ts'],
    testTimeout: 120_000,
  },
});
