import eslint from '@eslint/js';
import sonarjs from 'eslint-plugin-sonarjs';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'docs/**',
      '.superpowers/**',
      '.worktrees/**',
      '.codegraph/**',
      'coverage/**',
      'fixtures/**',
      'obsidian-plugin/**',
      '.agents/**',
      '.claude/**',
      '.codex/**',
      '.forge/**',
      '.opencode/**',
      '.pi/**',
      'reports/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  sonarjs.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            '*.js',
            'vitest.config.ts',
            'vitest.integration.config.ts',
            'vitest.e2e-watcher.config.ts',
            'vitest.reranker.config.ts',
          ],
        },
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Redundant with @typescript-eslint/no-unused-vars which has better TS-aware ignore patterns
      'sonarjs/no-unused-vars': 'off',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { disallowTypeAnnotations: false }],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      // Raise threshold — existing complex pipeline functions are intentionally dense
      'sonarjs/cognitive-complexity': ['error', 30],
      // MD5 is used for content-change detection (not passwords/security) — false positive
      'sonarjs/hashing': 'off',
      // MCP SDK deprecated Server in favour of McpServer; migration is out of scope
      'sonarjs/deprecation': 'off',
      // .sort().map() on a freshly-parsed API response buffer is intentional
      'sonarjs/no-misleading-array-reverse': 'off',
      // Nested ternaries in result-object construction are readable and idiomatic here
      'sonarjs/no-nested-conditional': 'off',
      // Regex is simple character-class repetition; no ReDoS risk in practice
      'sonarjs/slow-regex': 'off',
      // Deep nesting in batch-processing loops is architectural, not accidental
      'sonarjs/no-nested-functions': 'off',
      // /tmp usage in vitest.config.ts is intentional for test isolation
      'sonarjs/publicly-writable-directories': 'off',
    },
  },
  {
    files: ['src/inference/embedder.ts', 'src/inference/reranker.ts'],
    linterOptions: {
      reportUnusedDisableDirectives: false,
    },
  },
  {
    // Node tooling and optional host adapters are outside the runtime TS project.
    // Keep syntax/Sonar rules; typed rules apply to src, eval, tests and TS configs.
    files: ['**/*.{js,mjs,cjs}', '.ai/scripts/**/*.ts'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        AbortSignal: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        performance: 'readonly',
        URLSearchParams: 'readonly',
      },
    },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
    },
  },
  // CommonJS helpers are consumed by Node require(), not the ESM runtime.
  {
    files: ['**/*.cjs'],
    languageOptions: {
      globals: { require: 'readonly', module: 'readonly', __dirname: 'readonly' },
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: ['.ai/skills/brainstorming/scripts/helper.js'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        WebSocket: 'readonly',
      },
    },
  },
  {
    files: [
      '.ai/skills/brainstorming/scripts/helper.js',
      '.ai/skills/brainstorming/scripts/server.cjs',
    ],
    rules: {
      // This optional helper talks to the local visual-companion WebSocket server.
      'sonarjs/no-clear-text-protocols': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-unused-vars': ['error', { caughtErrors: 'none' }],
    },
  },
);
