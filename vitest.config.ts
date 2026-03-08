import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      VAULT_PATH: '/tmp/test-vault',
    },
    pool: 'threads',
    singleThread: true,
  },
});
