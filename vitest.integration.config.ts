import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/setup-vault-environment.ts'],
    include: ['test/integration.test.ts'],
    testTimeout: 120_000,
  },
});
