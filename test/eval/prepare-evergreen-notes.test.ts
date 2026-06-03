import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareEvergreenNotesFixture } from '../../eval/prepare-evergreen-notes.js';

function noteHtml(note: {
  slug: string;
  title: string;
  contentMarkdown: string;
  linkedNoteSlugs?: string[];
  mtimeMillis?: number;
}): string {
  return `<html><body><script id="notetower-initial-data" type="application/json">${JSON.stringify({
    noteCache: {
      [note.slug]: {
        data: {
          slug: note.slug,
          title: note.title,
          contentMarkdown: note.contentMarkdown,
          linkedNoteSlugs: note.linkedNoteSlugs ?? [],
          mtimeMillis: note.mtimeMillis,
        },
      },
    },
  })}</script></body></html>`;
}

describe('prepareEvergreenNotesFixture()', () => {
  let tempRoot: string | undefined;

  afterEach(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
  });

  function makeVaultPath(): string {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'ohs-evergreen-'));
    return path.join(tempRoot, 'fixtures/evergreen-notes/dataset');
  }

  it('crawls linked notes and writes an Obsidian vault', async () => {
    const vault = makeVaultPath();
    const pages = new Map([
      [
        'About_these_notes',
        noteHtml({
          slug: 'About_these_notes',
          title: 'About these notes',
          contentMarkdown:
            '# About these notes\n\nSee [[zChild:::Child note]].\n\n![](BearImages/image-one.png)\n',
          linkedNoteSlugs: ['zChild'],
          mtimeMillis: Date.UTC(2024, 0, 2),
        }),
      ],
      [
        'zChild',
        noteHtml({
          slug: 'zChild',
          title: '\u0004Child note',
          contentMarkdown: '# \u0004Child note\n\nBack to [[About_these_notes:::About]].\n',
          linkedNoteSlugs: ['About_these_notes'],
          mtimeMillis: Date.UTC(2024, 0, 3),
        }),
      ],
    ]);
    const downloadedImages: string[] = [];

    const result = await prepareEvergreenNotesFixture({
      vault,
      repoRoot: tempRoot!,
      seeds: ['About_these_notes'],
      politenessDelayMs: 0,
      fetchPage: (slug) => Promise.resolve(pages.get(slug) ?? null),
      fetchBinary: (relativePath) => {
        downloadedImages.push(relativePath);
        return Promise.resolve(Buffer.from('png-bytes'));
      },
    });

    expect(result).toEqual({
      notesWritten: 2,
      imagesDownloaded: 1,
      imagesSkipped: 0,
      imagesFailed: 0,
      vault,
    });

    const about = readFileSync(path.join(vault, 'About_these_notes.md'), 'utf-8');
    const child = readFileSync(path.join(vault, 'zChild.md'), 'utf-8');

    expect(about).toContain('title: "About these notes"');
    expect(about).toContain('modified: 2024-01-02');
    expect(about).toContain('[[zChild|Child note]]');
    expect(child).toContain('title: "Child note"');
    expect(child).toContain('# Child note');
    expect(downloadedImages).toEqual(['BearImages/image-one.png']);
    expect(readFileSync(path.join(vault, 'BearImages/image-one.png'), 'utf-8')).toBe('png-bytes');
  });

  it('skips an existing vault unless force is set', async () => {
    const vault = makeVaultPath();
    mkdirSync(vault, { recursive: true });
    writeFileSync(path.join(vault, 'Existing.md'), '# Existing\n');

    const result = await prepareEvergreenNotesFixture({
      vault,
      repoRoot: tempRoot!,
      seeds: ['About_these_notes'],
      fetchPage: () => {
        return Promise.reject(new Error('fetch should not be called'));
      },
    });

    expect(result.notesWritten).toBe(0);
    expect(readFileSync(path.join(vault, 'Existing.md'), 'utf-8')).toBe('# Existing\n');
  });

  it('refuses to recreate a vault outside fixtures', async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'ohs-evergreen-'));

    await expect(
      prepareEvergreenNotesFixture({
        vault: path.join(tempRoot, 'not-fixtures/evergreen-notes/dataset'),
        repoRoot: tempRoot,
        force: true,
        fetchPage: () => Promise.resolve(null),
      }),
    ).rejects.toThrow(/outside fixtures/);
  });

  it('skips existing downloaded images', async () => {
    const vault = makeVaultPath();
    mkdirSync(path.join(vault, 'BearImages'), { recursive: true });
    writeFileSync(path.join(vault, 'BearImages/image-one.png'), 'existing');

    const result = await prepareEvergreenNotesFixture({
      vault,
      repoRoot: tempRoot!,
      seeds: ['About_these_notes'],
      politenessDelayMs: 0,
      fetchPage: () =>
        Promise.resolve(
          noteHtml({
            slug: 'About_these_notes',
            title: 'About these notes',
            contentMarkdown: '![](BearImages/image-one.png)\n',
            linkedNoteSlugs: [],
          }),
        ),
      fetchBinary: () => {
        return Promise.reject(new Error('image fetch should not be called'));
      },
    });

    expect(result.imagesDownloaded).toBe(0);
    expect(result.imagesSkipped).toBe(1);
    expect(existsSync(path.join(vault, 'BearImages/image-one.png'))).toBe(true);
  });
});
