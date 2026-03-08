import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { parseInlineTags } from '../src/indexer.js';

describe('parseInlineTags', () => {
  it('extracts simple inline tags', () => {
    const tags = parseInlineTags('Some text #pkm and #zettelkasten here');
    assert.ok(tags.includes('pkm'));
    assert.ok(tags.includes('zettelkasten'));
  });

  it('extracts hierarchical tags', () => {
    const tags = parseInlineTags('This is #note/basic/primary content');
    assert.ok(tags.includes('note/basic/primary'));
  });

  it('does not match tags inside code blocks', () => {
    const tags = parseInlineTags('Normal #real-tag\n```\n#fake-tag in code\n```');
    assert.ok(tags.includes('real-tag'));
    assert.ok(!tags.includes('fake-tag'), 'tags in code blocks should be ignored');
  });

  it('does not match tags starting with digits', () => {
    const tags = parseInlineTags('Number #123 and #42foo are not tags');
    assert.ok(!tags.includes('123'), '#123 should not be a tag (starts with digit)');
    assert.ok(!tags.includes('42foo'), '#42foo should not be a tag (starts with digit)');
  });

  it('deduplicates repeated tags', () => {
    const tags = parseInlineTags('#pkm first mention and #pkm second mention');
    assert.equal(tags.filter((t) => t === 'pkm').length, 1);
  });
});
