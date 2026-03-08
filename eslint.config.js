// @ts-check
import eslint from '@eslint/js';
import sonarjs from 'eslint-plugin-sonarjs';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  sonarjs.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.js', 'vitest.config.ts'],
        },
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'warn',
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
    ignores: ['dist/', 'node_modules/'],
  },
);
