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
