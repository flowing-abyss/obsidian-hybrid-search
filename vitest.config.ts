import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      VAULT_PATH: '/tmp/test-vault',
    },
    maxWorkers: 1,
    testTimeout: 30_000,
    isolate: false,
    // Runs before every test file: clears the module registry the files share under
    // `isolate: false`, so none of them inherits another file's vault binding.
    setupFiles: ['./test/setup-module-isolation.ts'],
    include: ['test/**/*.test.ts'],
    // integration.test.ts needs a real embedder; indexer-watcher-live-e2e.test.ts
    // runs a real (unmocked) chokidar watcher whose shared module state would
    // leak into the isolate:false suite — both run standalone via their own
    // npm scripts (test:integration / test:e2e-watcher).
    exclude: [
      'test/integration.test.ts',
      'test/indexer-watcher-live-e2e.test.ts',
      'test/indexer-git-exclude-live-e2e.test.ts',
      'test/reranker-real-model.test.ts',
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      thresholds: {
        lines: 71,
        functions: 77,
        branches: 55,
        // Measured on the full unit suite; keep pure transformation boundaries covered.
        'src/content/chunker.ts': { lines: 95, functions: 100, branches: 90 },
        'src/contracts/filter-predicate.ts': { lines: 100, functions: 100, branches: 95 },
        'src/content/note-extractor.ts': { lines: 95, functions: 85, branches: 85 },
        'src/content/text-normalization.ts': { lines: 100, functions: 100, branches: 100 },
        'src/storage/index-state.ts': { lines: 100, functions: 100, branches: 100 },
      },
    },
  },
});
