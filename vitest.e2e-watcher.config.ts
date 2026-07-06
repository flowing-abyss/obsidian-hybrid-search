import { defineConfig } from 'vitest/config';

// Runs the live watcher e2e in its own process so the real (unmocked) chokidar
// watcher's shared module state can't leak into the main isolate:false suite.
export default defineConfig({
  test: {
    include: ['test/indexer-watcher-live-e2e.test.ts'],
    testTimeout: 30_000,
  },
});
