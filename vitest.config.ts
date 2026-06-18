import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      VAULT_PATH: '/tmp/test-vault',
    },
    maxWorkers: 1,
    testTimeout: 30_000,
    isolate: false,
    include: ['test/**/*.test.ts'],
    exclude: ['test/integration.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      thresholds: {
        lines: 71,
        functions: 77,
        branches: 55,
      },
    },
  },
});
