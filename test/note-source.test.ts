import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createNoteSourceReader } from '../src/vault/note-source.js';

let vault: string;
beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'ohs-note-source-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(vault, { recursive: true, force: true });
});

it('reads the current original source including YAML/comments and preserves empty files', () => {
  const reader = createNoteSourceReader(vault);
  const file = path.join(vault, 'note.md');
  fs.writeFileSync(file, '---\ntitle: Metadata\n---\nOriginal %%knowledge%% body\r\n');
  expect(reader.read('note.md')).toBe('---\ntitle: Metadata\n---\nOriginal %%knowledge%% body\r\n');
  fs.writeFileSync(file, 'Edited body');
  expect(reader.read('note.md')).toBe('Edited body');
  fs.writeFileSync(file, '');
  expect(reader.read('note.md')).toBe('');
});

it.each(['NFC', 'NFD'] as const)('resolves %s physical names with NFD stored identity', (form) => {
  const directory = 'café'.normalize(form);
  const filename = 'naïve note.md'.normalize(form);
  fs.mkdirSync(path.join(vault, directory));
  fs.writeFileSync(path.join(vault, directory, filename), 'Original Unicode content');
  expect(createNoteSourceReader(vault).read('café/naïve note.md'.normalize('NFD'))).toBe(
    'Original Unicode content',
  );
});

it('resolves mixed-normalization path components independently', () => {
  const physical = path.join(vault, 'café'.normalize('NFC'), 'école'.normalize('NFD'));
  fs.mkdirSync(physical, { recursive: true });
  fs.writeFileSync(path.join(physical, 'résumé.md'.normalize('NFC')), 'Mixed path');
  expect(createNoteSourceReader(vault).read('café/école/résumé.md'.normalize('NFD'))).toBe(
    'Mixed path',
  );
});

it('returns a miss for a deleted file and a missing parent directory', () => {
  const reader = createNoteSourceReader(vault);
  const file = path.join(vault, 'note.md');
  fs.writeFileSync(file, 'Before deletion');
  expect(reader.read('note.md')).toBe('Before deletion');
  fs.unlinkSync(file);
  expect(reader.read('note.md')).toBeNull();
  expect(reader.read('missing/child.md')).toBeNull();
  fs.writeFileSync(file, 'A file is not a directory');
  expect(reader.read('note.md/child.md')).toBeNull();
});

it('reports a directory read error instead of returning a missing or empty body', () => {
  fs.mkdirSync(path.join(vault, 'directory.md'));
  expect(() => createNoteSourceReader(vault).read('directory.md')).toThrow(/read.*directory\.md/i);
});

it('reports permission errors without converting them into misses', () => {
  fs.writeFileSync(path.join(vault, 'private.md'), 'Private body');
  const denied = Object.assign(new Error('Access denied'), { code: 'EACCES' });
  vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => {
    throw denied;
  });
  expect(() => createNoteSourceReader(vault).read('private.md')).toThrow(/private\.md.*EACCES/i);
});

it.skipIf(process.platform === 'darwin')('rejects ambiguous normalized physical names', () => {
  fs.writeFileSync(path.join(vault, 'A\u030Aé.md'), 'First');
  fs.writeFileSync(path.join(vault, 'Åe\u0301.md'), 'Second');
  expect(() => createNoteSourceReader(vault).read('Åé.md'.normalize('NFD'))).toThrow(/ambiguous/i);
});

it.each(['../outside.md', 'folder/../../outside.md', '/outside.md', '', '.', 'bad\0name.md'])(
  'rejects non-relative file paths before reading: %s',
  async (input) => {
    const reader = createNoteSourceReader(vault);
    const read = vi.spyOn(fs, 'readFileSync');
    expect(() => reader.read(input)).toThrow(/vault-relative/i);
    expect(() => reader.stat(input)).toThrow(/vault-relative/i);
    await expect(reader.readWithStat(input)).rejects.toThrow(/vault-relative/i);
    expect(read).not.toHaveBeenCalled();
  },
);

it('reads async content and metadata from the same open source', async () => {
  const filename = path.join(vault, 'note.md');
  const raw = 'Async source with café and русский';
  fs.writeFileSync(filename, raw);
  const reader = createNoteSourceReader(vault);
  const read = await reader.readWithStat('note.md');
  expect(read?.raw).toBe(raw);
  expect(read?.stat.size).toBe(Buffer.byteLength(raw));
  expect(reader.stat('note.md')?.ino).toBe(read?.stat.ino);
  expect(await reader.readWithStat('missing.md')).toBeNull();
});

it.skipIf(process.platform === 'win32')(
  'rejects file and directory symlinks, including in-vault aliases',
  async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ohs-note-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'private.md'), 'OUTSIDE_SECRET');
      fs.writeFileSync(path.join(vault, 'inside.md'), 'Inside');
      fs.symlinkSync(path.join(outside, 'private.md'), path.join(vault, 'file.md'));
      fs.symlinkSync(outside, path.join(vault, 'directory'));
      fs.symlinkSync(path.join(vault, 'inside.md'), path.join(vault, 'alias.md'));
      const reader = createNoteSourceReader(vault);
      for (const target of ['file.md', 'directory/private.md', 'alias.md']) {
        expect(() => reader.read(target)).toThrow(/symbolic links/i);
        expect(() => reader.stat(target)).toThrow(/symbolic links/i);
        await expect(reader.readWithStat(target)).rejects.toThrow(/symbolic links/i);
      }
      expect(fs.readFileSync(path.join(outside, 'private.md'), 'utf8')).toBe('OUTSIDE_SECRET');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === 'win32')(
  'revalidates cached directory names after a directory is replaced by a link',
  () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ohs-note-swap-'));
    try {
      const physicalDirectory = path.join(vault, 'café');
      fs.mkdirSync(physicalDirectory);
      fs.writeFileSync(path.join(physicalDirectory, 'note.md'), 'Original');
      fs.writeFileSync(path.join(outside, 'note.md'), 'OUTSIDE_SECRET');
      const reader = createNoteSourceReader(vault);
      const target = 'café/note.md'.normalize('NFD');
      expect(reader.read(target)).toBe('Original');
      fs.rmSync(physicalDirectory, { recursive: true });
      fs.symlinkSync(outside, physicalDirectory);
      expect(() => reader.read(target)).toThrow(/symbolic links/i);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === 'win32')(
  'supports a vault selected through a directory symlink',
  () => {
    const links = fs.mkdtempSync(path.join(os.tmpdir(), 'ohs-vault-root-link-'));
    try {
      fs.writeFileSync(path.join(vault, 'note.md'), 'Vault body');
      fs.symlinkSync(vault, path.join(links, 'vault'));
      expect(createNoteSourceReader(path.join(links, 'vault')).read('note.md')).toBe('Vault body');
    } finally {
      fs.rmSync(links, { recursive: true, force: true });
    }
  },
);
