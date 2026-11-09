import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  ReadToolArgumentsSchema,
  SearchOptionsBoundarySchema,
  SearchToolArgumentsSchema,
  StdioRequestSchema,
  parseStringArrayParam,
} from '../src/contracts/boundary-validation.js';

describe('request resource budgets', () => {
  it('bounds fan-out in both MCP and IPC before invoking inference', () => {
    const queries = Array.from({ length: 17 }, () => 'small query');
    assert.equal(SearchToolArgumentsSchema.safeParse({ queries }).success, false);
    assert.equal(StdioRequestSchema.safeParse({ query: '', options: { queries } }).success, false);
    assert.equal(
      SearchToolArgumentsSchema.safeParse({ query: 'primary', queries: queries.slice(1) }).success,
      false,
    );
  });

  it('bounds individual query text', () => {
    const query = 'x'.repeat(16_385);
    assert.equal(SearchToolArgumentsSchema.safeParse({ query }).success, false);
    assert.equal(StdioRequestSchema.safeParse({ query }).success, false);
  });

  it('preserves zero-limit semantics while rejecting impractical numeric budgets', () => {
    assert.equal(
      SearchOptionsBoundarySchema.safeParse({ limit: 0, snippetLength: 0, depth: 0 }).success,
      true,
    );
    for (const options of [{ limit: 10_001 }, { snippetLength: 100_001 }, { depth: 65 }]) {
      assert.equal(SearchOptionsBoundarySchema.safeParse(options).success, false);
    }
    assert.equal(
      ReadToolArgumentsSchema.safeParse({ paths: 'note.md', snippet_length: 100_001 }).success,
      false,
    );
  });

  it('rejects oversized filter and read-path arrays, including encoded arrays', () => {
    const paths = Array.from({ length: 129 }, () => 'note.md');
    for (const value of [paths, JSON.stringify(paths)]) {
      assert.throws(() => parseStringArrayParam('paths', value), /at most 128/);
      assert.throws(() => parseStringArrayParam('scope', value), /at most 128/);
    }
    assert.throws(() => parseStringArrayParam('tag', 'x'.repeat(4097)), /4096/);
    assert.throws(() => parseStringArrayParam('scope', ['x'.repeat(4097)]), /4096/);
  });
});
