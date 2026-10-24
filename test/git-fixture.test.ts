import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { afterEach, describe, it, vi } from 'vitest';
import { createGitFixture } from './helpers/git-fixture.js';

let fixture: ReturnType<typeof createGitFixture> | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  fixture?.dispose();
  fixture = undefined;
});

describe('Git fixture file updates', () => {
  it('rewrites existing hidden gitfiles in place without leaving trailing bytes', () => {
    fixture = createGitFixture({ linked: true });
    const gitfile = path.join(fixture.repo, '.git');
    const sameFile = path.join(fixture.root, 'gitfile hard link');
    fs.linkSync(gitfile, sameFile);
    const open = fs.openSync;
    const write = fs.writeFileSync;
    const rejectHiddenCreate = (file: fs.PathLike | number, flag: unknown) => {
      if (file === gitfile && fs.existsSync(gitfile) && flag === 'w') {
        throw Object.assign(new Error('existing hidden file'), { code: 'EPERM' });
      }
    };
    vi.spyOn(fs, 'openSync').mockImplementation((file, flag, mode) => {
      rejectHiddenCreate(file, flag);
      return open(file, flag, mode);
    });
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
      rejectHiddenCreate(file, typeof options === 'object' ? (options?.flag ?? 'w') : 'w');
      write(file, data, options);
    });
    syncBuiltinESMExports();

    for (const content of ['gitdir: Café\n', 'x', '']) {
      fixture.write('.git', content);
      assert.equal(fs.readFileSync(gitfile, 'utf8'), content);
      assert.equal(fs.readFileSync(sameFile, 'utf8'), content, 'preserve the existing file');
    }
    fixture.write('new/note.md', '# Created');
    assert.equal(fs.readFileSync(path.join(fixture.repo, 'new/note.md'), 'utf8'), '# Created');
  });

  it('closes an opened fixture file if writing fails', () => {
    fixture = createGitFixture({ linked: true });
    const write = fs.writeFileSync;
    let failedDescriptor: number | undefined;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
      if (typeof file === 'number') {
        failedDescriptor = file;
        throw Object.assign(new Error('write failed'), { code: 'EIO' });
      }
      write(file, data, options);
    });
    syncBuiltinESMExports();
    assert.throws(() => fixture!.write('.git', 'replacement'), /write failed/);
    assert.notEqual(failedDescriptor, undefined);
    assert.throws(
      () => fs.fstatSync(failedDescriptor!),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'EBADF',
    );
  });
});
