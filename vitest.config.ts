import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      VAULT_PATH: '/tmp/test-vault',
    },
    pool: 'threads',
    singleThread: true,
    include: ['test/**/*.test.ts'],
    exclude: ['test/integration.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      thresholds: { lines: 25 },
    },
  },
});
