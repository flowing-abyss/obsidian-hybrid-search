import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { matchesCorpus, prepareObsidianHelpFixture } from '../../eval/prepare-obsidian-help.js';

describe('pinned Obsidian Help preparation', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });
  function fixture() {
    const root = mkdtempSync(path.join(tmpdir(), 'ohs-corpus-'));
    roots.push(root);
    const vault = path.join(root, 'fixtures/obsidian-help/dataset');
    const sourceDir = path.join(root, 'source');
    mkdirSync(vault, { recursive: true });
    mkdirSync(path.join(sourceDir, 'en'), { recursive: true });
    writeFileSync(path.join(vault, 'Existing.md'), '# Keep until replacement is validated\n');
    return { repoRoot: root, vault, sourceDir };
  }
  it('rejects a partial source and preserves the existing fixture', () => {
    const options = fixture();
    writeFileSync(path.join(options.sourceDir, 'en/Start.md'), '# Incomplete\n');
    expect(() => prepareObsidianHelpFixture(options)).toThrow(/pinned corpus/);
    expect(readFileSync(path.join(options.vault, 'Existing.md'), 'utf8')).toContain('Keep');
  });
  it('does not mistake one existing Markdown file for complete preparation', () => {
    const options = fixture();
    expect(() => prepareObsidianHelpFixture(options)).toThrow(/pinned corpus/);
  });
  it('rejects replacement outside the fixture directory', () => {
    const options = fixture();
    expect(() => prepareObsidianHelpFixture({ ...options, vault: options.repoRoot })).toThrow(
      /outside fixtures/,
    );
  });
});

it('accepts exact corpus bytes, ignores DB artifacts, and rejects changed, extra or missing Markdown', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ohs-corpus-integrity-'));
  const expected = { 'Hello.md': 'ce013625030ba8dba906f756967f9e9ca394464a' };
  try {
    writeFileSync(path.join(root, 'Hello.md'), 'hello\n');
    expect(matchesCorpus(root, expected)).toBe(true);
    writeFileSync(path.join(root, '.obsidian-hybrid-search.db'), 'derived index');
    expect(matchesCorpus(root, expected)).toBe(true);
    writeFileSync(path.join(root, 'Extra.md'), 'hello\n');
    expect(matchesCorpus(root, expected)).toBe(false);
    rmSync(path.join(root, 'Extra.md'));
    writeFileSync(path.join(root, 'Hello.md'), 'changed\n');
    expect(matchesCorpus(root, expected)).toBe(false);
    rmSync(path.join(root, 'Hello.md'));
    expect(matchesCorpus(root, expected)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
