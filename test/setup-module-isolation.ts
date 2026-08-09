import { vi } from 'vitest';

/**
 * Give every test file a fresh module graph.
 *
 * The suite runs with `isolate: false`, so all test files share one module registry.
 * Most files bind src/db.js and src/searcher.js to their OWN vault by setting
 * process.env.OBSIDIAN_VAULT_PATH at module scope and then dynamically importing —
 * which only works if those modules have not already been instantiated by an earlier
 * file. A handful of files call vi.resetModules() themselves to guarantee that; the
 * rest were relying on running before any of them.
 *
 * Vitest orders files by size, so adding or growing a test file reshuffles that order
 * and silently rebinds an unrelated file to the previous file's vault and embedder
 * mock. That is how test/searcher.test.ts came to run against the 4-dim pushdown
 * fixture on Windows: `search('', {})` returned 10 notes instead of 0, and a fixture
 * note the file had seeded itself was simply absent.
 *
 * A setup file runs before each test file is evaluated, so resetting here makes the
 * guarantee unconditional instead of per-file and order-dependent.
 */
vi.resetModules();
