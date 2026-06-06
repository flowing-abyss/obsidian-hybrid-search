import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

    const about = readFileSync(path.join(vault, 'notes/About these notes.md'), 'utf-8');
    const child = readFileSync(path.join(vault, 'notes/Child note.md'), 'utf-8');

    expect(about).toContain('url: "https://notes.andymatuschak.org/About_these_notes"');
    expect(about).not.toContain('title:');
    expect(about).not.toContain('slug:');
    expect(about).toContain('modified: 2024-01-02');
    expect(about).toContain('[[Child note]]');
    expect(about).toContain('![[files/image-one.png]]');
    expect(child).toContain('url: "https://notes.andymatuschak.org/zChild"');
    expect(child).not.toContain('title:');
    expect(child).not.toContain('slug:');
    expect(child).toContain('# Child note');
    expect(child).toContain('[[About these notes]]');
    expect(downloadedImages).toEqual(['BearImages/image-one.png']);
    expect(readFileSync(path.join(vault, 'files/image-one.png'), 'utf-8')).toBe('png-bytes');
  });

  it('disambiguates duplicate note titles with numeric suffixes', async () => {
    const vault = makeVaultPath();
    const pages = new Map([
      [
        'zFirst',
        noteHtml({
          slug: 'zFirst',
          title: 'Same title',
          contentMarkdown: '# Same title\n\nSee [[zSecond:::Same title]].\n',
          linkedNoteSlugs: ['zSecond'],
        }),
      ],
      [
        'zSecond',
        noteHtml({
          slug: 'zSecond',
          title: 'Same title',
          contentMarkdown: '# Same title\n\nBack to [[zFirst:::Same title]].\n',
          linkedNoteSlugs: ['zFirst'],
        }),
      ],
    ]);

    await prepareEvergreenNotesFixture({
      vault,
      repoRoot: tempRoot!,
      seeds: ['zFirst'],
      politenessDelayMs: 0,
      fetchPage: (slug) => Promise.resolve(pages.get(slug) ?? null),
      fetchBinary: () => Promise.reject(new Error('image fetch should not be called')),
    });

    const first = readFileSync(path.join(vault, 'notes/Same title.md'), 'utf-8');
    const second = readFileSync(path.join(vault, 'notes/Same title 2.md'), 'utf-8');

    expect(first).toContain('url: "https://notes.andymatuschak.org/zFirst"');
    expect(first).toContain('[[Same title 2]]');
    expect(second).toContain('url: "https://notes.andymatuschak.org/zSecond"');
    expect(second).toContain('[[Same title]]');
  });

  it('keeps title filenames below filesystem length limits', async () => {
    const vault = makeVaultPath();
    const longTitle =
      'Guo, P. (2021). Ten Million Users and Ten Years Later Python Tutor’s Design Guidelines for Building Scalable and Sustainable Research Software in Academia. In The 34th Annual ACM Symposium on User Interface Software and Technology (pp. 1235–1251). Association for Computing Machinery';

    await prepareEvergreenNotesFixture({
      vault,
      repoRoot: tempRoot!,
      seeds: ['zLong'],
      politenessDelayMs: 0,
      fetchPage: () =>
        Promise.resolve(
          noteHtml({
            slug: 'zLong',
            title: longTitle,
            contentMarkdown: `# ${longTitle}\n`,
            linkedNoteSlugs: [],
          }),
        ),
      fetchBinary: () => Promise.reject(new Error('image fetch should not be called')),
    });

    const files = readdirSync(path.join(vault, 'notes'));

    expect(files).toHaveLength(1);
    expect(files[0]!.length).toBeLessThanOrEqual(200);
    expect(files[0]).toMatch(/^Guo, P\. \(2021\)\. Ten Million Users/);
    expect(readFileSync(path.join(vault, 'notes', files[0]!), 'utf-8')).toContain(
      'url: "https://notes.andymatuschak.org/zLong"',
    );
  });

  it('keeps uncrawled note links human-readable without slugs when titles are available', async () => {
    const vault = makeVaultPath();

    await prepareEvergreenNotesFixture({
      vault,
      repoRoot: tempRoot!,
      seeds: ['zSource'],
      politenessDelayMs: 0,
      fetchPage: () =>
        Promise.resolve(
          noteHtml({
            slug: 'zSource',
            title: 'Source note',
            contentMarkdown:
              '# Source note\n\nA visible missing link: [[zMissing:::Visible missing note]].\n',
            linkedNoteSlugs: [],
          }),
        ),
      fetchBinary: () => Promise.reject(new Error('image fetch should not be called')),
    });

    const source = readFileSync(path.join(vault, 'notes/Source note.md'), 'utf-8');

    expect(source).toContain('[[Visible missing note]]');
    expect(source).not.toContain('zMissing');
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
    mkdirSync(path.join(vault, 'files'), { recursive: true });
    writeFileSync(path.join(vault, 'files/image-one.png'), 'existing');

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
    expect(existsSync(path.join(vault, 'files/image-one.png'))).toBe(true);
  });
});
