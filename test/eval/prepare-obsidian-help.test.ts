import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareObsidianHelpFixture } from '../../eval/prepare-obsidian-help.js';

describe('prepareObsidianHelpFixture()', () => {
  let tempRoot: string | undefined;

  afterEach(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
  });

  it('copies the English Obsidian Help vault from a source checkout', () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'ohs-obsidian-help-'));
    const source = path.join(tempRoot, 'source');
    const vault = path.join(tempRoot, 'fixtures/obsidian-help/dataset');
    mkdirSync(path.join(source, 'en/Getting started'), { recursive: true });
    mkdirSync(path.join(source, 'ru'), { recursive: true });
    writeFileSync(path.join(source, 'en/Getting started/Start here.md'), '# Start here\n');
    writeFileSync(path.join(source, 'ru/Начало.md'), '# Начало\n');

    const result = prepareObsidianHelpFixture({
      vault,
      sourceDir: source,
      repoRoot: tempRoot,
      force: true,
    });

    expect(result).toEqual({
      copied: true,
      source: source,
      vault,
    });
    expect(readFileSync(path.join(vault, 'Getting started/Start here.md'), 'utf-8')).toBe(
      '# Start here\n',
    );
    expect(() => readFileSync(path.join(vault, '../ru/Начало.md'), 'utf-8')).toThrow();
  });

  it('skips existing fixtures unless force is set', () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'ohs-obsidian-help-'));
    const source = path.join(tempRoot, 'source');
    const vault = path.join(tempRoot, 'fixtures/obsidian-help/dataset');
    mkdirSync(path.join(source, 'en'), { recursive: true });
    mkdirSync(vault, { recursive: true });
    writeFileSync(path.join(vault, 'Existing.md'), '# Existing\n');

    const result = prepareObsidianHelpFixture({
      vault,
      sourceDir: source,
      repoRoot: tempRoot,
    });

    expect(result.copied).toBe(false);
    expect(readFileSync(path.join(vault, 'Existing.md'), 'utf-8')).toBe('# Existing\n');
  });
});
