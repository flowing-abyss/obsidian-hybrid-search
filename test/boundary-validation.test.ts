import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { z } from 'zod';
import {
  EmbeddingApiResponseSchema,
  SearchOptionsBoundarySchema,
  SearchToolArgumentsSchema,
  formatValidationError,
  parseCliIntegerOption,
  parseCliNumberOption,
  parseStringArrayParam,
} from '../src/boundary-validation.js';

describe('formatValidationError', () => {
  it('formats field paths and messages without exposing Zod internals', () => {
    const schema = z.object({
      limit: z.number(),
      mode: z.enum(['hybrid', 'semantic']),
    });
    const result = schema.safeParse({ limit: 'ten', mode: 'title' });

    assert.equal(result.success, false);
    const message = formatValidationError('search arguments', result.error);

    assert.match(message, /^Invalid search arguments:/);
    assert.match(message, /limit/);
    assert.match(message, /expected number/i);
    assert.match(message, /mode/);
    assert.match(message, /invalid option/i);
    assert.doesNotMatch(message, /invalid_type/);
    assert.doesNotMatch(message, /ZodError/);
  });
});

describe('parseStringArrayParam', () => {
  it('accepts a string', () => {
    assert.equal(parseStringArrayParam('scope', 'notes'), 'notes');
  });

  it('accepts an array of strings', () => {
    assert.deepEqual(parseStringArrayParam('scope', ['notes', '-archive']), ['notes', '-archive']);
  });

  it('accepts a JSON-stringified string array', () => {
    assert.deepEqual(parseStringArrayParam('scope', '["notes","-archive"]'), ['notes', '-archive']);
  });

  it('accepts a whitespace-wrapped JSON-stringified string array', () => {
    assert.deepEqual(parseStringArrayParam('scope', ' ["notes","-archive"] '), [
      'notes',
      '-archive',
    ]);
  });

  it('treats unparseable JSON-looking strings as plain strings', () => {
    assert.equal(parseStringArrayParam('scope', '[notes'), '[notes');
  });

  it('rejects arrays containing non-strings', () => {
    assert.throws(
      () => parseStringArrayParam('scope', ['notes', 42]),
      /Invalid scope: expected string or array of strings/,
    );
  });
});

describe('parseCliIntegerOption', () => {
  it('parses an integer string', () => {
    assert.equal(parseCliIntegerOption('limit', '10'), 10);
  });

  it('rejects suffixes', () => {
    assert.throws(() => parseCliIntegerOption('limit', '10abc'), /Invalid limit/);
  });

  it('rejects decimals', () => {
    assert.throws(() => parseCliIntegerOption('limit', '1.5'), /Invalid limit/);
  });
});

describe('parseCliNumberOption', () => {
  it('parses a finite decimal string', () => {
    assert.equal(parseCliNumberOption('threshold', '0.25'), 0.25);
  });

  it('rejects Infinity', () => {
    assert.throws(() => parseCliNumberOption('threshold', 'Infinity'), /Invalid threshold/);
  });

  it('rejects non-numeric strings', () => {
    assert.throws(() => parseCliNumberOption('threshold', 'abc'), /Invalid threshold/);
  });
});

describe('SearchOptionsBoundarySchema', () => {
  it('accepts supported related link graph selectors', () => {
    for (const linkType of ['wiki', 'markdown', 'all']) {
      const result = SearchOptionsBoundarySchema.safeParse({ linkType });

      assert.equal(result.success, true, `expected ${linkType} to be accepted`);
    }
  });

  it('rejects unsupported related link graph selectors', () => {
    const result = SearchOptionsBoundarySchema.safeParse({ linkType: 'url' });

    assert.equal(result.success, false);
    if (!result.success) {
      assert.match(formatValidationError('search options', result.error), /linkType/);
    }
  });

  it('rejects search option numeric values outside CLI domains', () => {
    const invalidOptions = [
      { field: 'limit', options: { limit: -1 } },
      { field: 'limit', options: { limit: 1.5 } },
      { field: 'threshold', options: { threshold: 2 } },
      { field: 'depth', options: { depth: -1 } },
      { field: 'snippetLength', options: { snippetLength: -1 } },
    ];

    for (const { field, options } of invalidOptions) {
      const result = SearchOptionsBoundarySchema.safeParse(options);

      assert.equal(result.success, false, `expected ${JSON.stringify(options)} to be rejected`);
      if (!result.success) {
        assert.match(formatValidationError('search options', result.error), new RegExp(field));
      }
    }
  });
});

describe('SearchToolArgumentsSchema', () => {
  it('accepts supported snake_case related link graph selectors', () => {
    for (const link_type of ['wiki', 'markdown', 'all']) {
      const result = SearchToolArgumentsSchema.safeParse({ link_type });

      assert.equal(result.success, true, `expected ${link_type} to be accepted`);
    }
  });

  it('rejects unsupported snake_case related link graph selectors', () => {
    const result = SearchToolArgumentsSchema.safeParse({ link_type: 'url' });

    assert.equal(result.success, false);
    if (!result.success) {
      assert.match(formatValidationError('search arguments', result.error), /link_type/);
    }
  });

  it('rejects snake_case snippet length outside CLI domain', () => {
    const result = SearchToolArgumentsSchema.safeParse({ snippet_length: -1 });

    assert.equal(result.success, false);
    if (!result.success) {
      assert.match(formatValidationError('search arguments', result.error), /snippet_length/);
    }
  });
});

describe('EmbeddingApiResponseSchema', () => {
  it('rejects an empty object', () => {
    assert.equal(EmbeddingApiResponseSchema.safeParse({}).success, false);
  });

  it('rejects unexpected response objects', () => {
    assert.equal(EmbeddingApiResponseSchema.safeParse({ unexpected: 'format' }).success, false);
  });

  it('accepts provider error responses with optional message', () => {
    assert.equal(
      EmbeddingApiResponseSchema.safeParse({ error: { message: 'model not found' } }).success,
      true,
    );
  });
});
