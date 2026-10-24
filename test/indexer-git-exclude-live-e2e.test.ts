import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import { createGitFixture } from './helpers/git-fixture.js';

const previousEnv = { ...process.env };
let fixture: ReturnType<typeof createGitFixture>;
let db: typeof import('../src/storage/db.js');
let indexer: typeof import('../src/indexing/indexer.js');
let embedder: typeof import('../src/inference/embedder.js');
let watcher: ReturnType<typeof indexer.startWatcher> | undefined;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean, ms = 6000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (predicate()) return;
    await wait(50);
  }
  assert.ok(predicate(), 'live filesystem change must reach SQLite');
}
function indexedPaths(): string[] {
  return (
    db.getDb().prepare('SELECT path FROM notes ORDER BY path').all() as { path: string }[]
  ).map((row) => row.path);
}
function retainedSnapshot() {
  return {
    notes: db
      .getDb()
      .prepare("SELECT * FROM notes WHERE path != 'duplicate/copy.md' ORDER BY id")
      .all(),
    chunks: db
      .getDb()
      .prepare(
        "SELECT c.*, hex(v.embedding) AS embedding FROM chunks c JOIN notes n ON n.id = c.note_id JOIN vec_chunks v ON v.chunk_id = c.id WHERE n.path != 'duplicate/copy.md' ORDER BY c.id",
      )
      .all(),
  };
}
async function startIndex() {
  const result = await indexer.indexVaultSync();
  assert.deepEqual(result.errors, []);
  assert.deepEqual(indexedPaths(), [
    'duplicate/copy.md',
    'rescued/Café.md'.normalize('NFD'),
    'retained.md',
  ]);
  watcher = indexer.startWatcher(512);
  await watcher.ready;
}
async function expectDuplicate(
  included: boolean,
  retained: ReturnType<typeof retainedSnapshot>,
  embeddings: number,
) {
  await waitFor(
    () =>
      indexedPaths().includes('duplicate/copy.md') === included &&
      !indexer.getIndexingStatus().isRunning &&
      indexer.getIndexingStatus().queued === 0,
  );
  assert.deepEqual(retainedSnapshot(), retained);
  assert.equal(vi.mocked(embedder.embedDetailed).mock.calls.length, embeddings);
  assert.equal(
    (db.getDb().prepare('SELECT COUNT(*) AS count FROM vec_chunks').get() as { count: number })
      .count,
    included ? 3 : 2,
  );
  vi.mocked(embedder.embedDetailed).mockClear();
}
function writeExclude(content: string) {
  mkdirSync(path.dirname(fixture.exclude), { recursive: true });
  writeFileSync(fixture.exclude, content);
}
function storedSignature() {
  return db
    .getDb()
    .prepare("SELECT value FROM settings WHERE key = 'ignore_state_signature'")
    .get();
}

for (const linked of [false, true]) {
  describe('live Git metadata: ' + (linked ? 'linked worktree' : 'ordinary repository'), () => {
    beforeEach(async () => {
      fixture = createGitFixture({ linked, vaultPrefix: 'projects/notes' });
      rmSync(path.dirname(fixture.exclude), { recursive: true });
      process.env.OBSIDIAN_VAULT_PATH = fixture.vault;
      process.env.OBSIDIAN_RESPECT_GITIGNORE = 'true';
      process.env.OBSIDIAN_INCLUDE_PATTERNS = 'rescued/**';
      process.env.OBSIDIAN_IGNORE_PATTERNS = 'hard/**';
      fixture.write('projects/notes/duplicate/copy.md', '# Duplicate\nSaved duplicate note');
      fixture.write('projects/notes/retained.md', '# Retained\nUnchanged control note');
      fixture.write('projects/notes/rescued/Café.md', '# Rescued\nExplicitly selected note');
      fixture.write('projects/notes/hard/excluded.md', '# Hard exclusion');
      vi.resetModules();
      db = await import('../src/storage/db.js');
      const { config } = await import('../src/runtime/config.js');
      config.debounce = 100;
      embedder = await import('../src/inference/embedder.js');
      vi.spyOn(embedder, 'embedDetailed').mockImplementation((texts: string[]) =>
        Promise.resolve(
          texts.map(() => ({
            ok: true as const,
            embedding: new Float32Array([0.1, 0.2, 0.3, 0.4]),
          })),
        ),
      );
      vi.spyOn(embedder, 'getContextLength').mockResolvedValue(512);
      vi.spyOn(embedder, 'getDocumentTokenPolicy').mockResolvedValue({
        limit: 508,
        count: (text) => Math.ceil(Array.from(text).length / 4),
      });
      indexer = await import('../src/indexing/indexer.js');
      db.openDb();
      db.initVecTable(4);
    });
    afterEach(async () => {
      await watcher?.close();
      watcher = undefined;
      await indexer?.withIndexingDbLock(() => {});
      db?.closeDb();
      vi.restoreAllMocks();
      syncBuiltinESMExports();
      vi.resetModules();
      for (const name of [
        'OBSIDIAN_VAULT_PATH',
        'OBSIDIAN_RESPECT_GITIGNORE',
        'OBSIDIAN_INCLUDE_PATTERNS',
        'OBSIDIAN_IGNORE_PATTERNS',
      ]) {
        if (previousEnv[name] === undefined) delete process.env[name];
        else process.env[name] = previousEnv[name];
      }
      fixture?.dispose();
    });
    it('observes a missing info directory and sweeps only newly excluded notes', async () => {
      await startIndex();
      const before = retainedSnapshot();
      vi.mocked(embedder.embedDetailed).mockClear();
      mkdirSync(path.dirname(fixture.exclude), { recursive: true });
      writeFileSync(fixture.exclude, '/projects/notes/duplicate/\n/projects/notes/rescued/\n');
      await waitFor(() => !indexedPaths().includes('duplicate/copy.md'));
      assert.deepEqual(retainedSnapshot(), before);
      assert.equal(vi.mocked(embedder.embedDetailed).mock.calls.length, 0);
      assert.ok(existsSync(path.join(fixture.vault, 'duplicate/copy.md')));
      assert.equal(
        (db.getDb().prepare('SELECT COUNT(*) AS count FROM vec_chunks').get() as { count: number })
          .count,
        2,
      );
    });
    it('handles atomic replacement, deletion and recreation without re-embedding retained notes', async () => {
      await startIndex();
      const before = retainedSnapshot();
      vi.mocked(embedder.embedDetailed).mockClear();
      const rule = '/projects/notes/duplicate/\n/projects/notes/rescued/\n';
      writeExclude(rule);
      await expectDuplicate(false, before, 0);
      writeFileSync(fixture.exclude + '.replacement', '# empty\n');
      renameSync(fixture.exclude + '.replacement', fixture.exclude);
      await expectDuplicate(true, before, 1);
      writeExclude(rule);
      await expectDuplicate(false, before, 0);
      unlinkSync(fixture.exclude);
      await expectDuplicate(true, before, 1);
      writeExclude(rule);
      await expectDuplicate(false, before, 0);
    });

    it('refreshes ancestor Gitignore negations outside the vault in precedence order', async () => {
      await startIndex();
      const before = retainedSnapshot();
      vi.mocked(embedder.embedDetailed).mockClear();
      writeExclude('/projects/notes/duplicate/\n');
      await expectDuplicate(false, before, 0);
      const rootRule = path.join(fixture.repo, '.gitignore');
      const negation = '!/projects/notes/duplicate/\n';
      writeFileSync(rootRule, negation);
      await expectDuplicate(true, before, 1);
      writeFileSync(rootRule, '# no negation\n');
      await expectDuplicate(false, before, 0);
      writeFileSync(rootRule + '.replacement', negation);
      renameSync(rootRule + '.replacement', rootRule);
      await expectDuplicate(true, before, 1);
      unlinkSync(rootRule);
      await expectDuplicate(false, before, 0);
      writeFileSync(rootRule, negation);
      await expectDuplicate(true, before, 1);
      const parentRule = path.join(fixture.repo, 'projects/.gitignore');
      writeFileSync(parentRule, 'notes/duplicate/\n');
      await expectDuplicate(false, before, 0);
      unlinkSync(parentRule);
      await expectDuplicate(true, before, 1);
    });

    it('disables both Git sources while continuing to observe Markdown edits', async () => {
      process.env.OBSIDIAN_RESPECT_GITIGNORE = 'false';
      writeExclude('/projects/notes/duplicate/\n');
      fixture.write('.gitignore', '*.md\n');
      await startIndex();
      const policy = await import('../src/vault/ignore.js');
      const build = vi.spyOn(policy, 'createIgnorePolicy');
      vi.mocked(embedder.embedDetailed).mockClear();
      writeExclude('/projects/notes/\n');
      fixture.write('.gitignore', 'projects/\n');
      fixture.write('projects/notes/.gitignore', '*\n');
      await wait(500);
      assert.equal(build.mock.calls.length, 0);
      assert.equal(vi.mocked(embedder.embedDetailed).mock.calls.length, 0);
      fixture.write(
        'projects/notes/retained.md',
        '# Retained\nEdited while Git ignores are disabled',
      );
      await waitFor(() => {
        const row = db
          .getDb()
          .prepare("SELECT content FROM notes WHERE path = 'retained.md'")
          .get() as { content: string };
        return row.content.includes('Edited');
      });
      assert.ok(indexedPaths().includes('duplicate/copy.md'));
      assert.equal(vi.mocked(embedder.embedDetailed).mock.calls.length, 1);
    });

    it('sweeps a saved version-3 index before startup without changing retained rows', async () => {
      await startIndex();
      await watcher!.close();
      watcher = undefined;
      const before = retainedSnapshot();
      db.getDb()
        .prepare("UPDATE settings SET value = ? WHERE key = 'ignore_state_signature'")
        .run(JSON.stringify({ matcherVersion: 3 }));
      writeExclude('/projects/notes/duplicate/\n/projects/notes/rescued/\n');
      vi.mocked(embedder.embedDetailed).mockClear();
      const result = await indexer.indexVaultSync();
      assert.equal(result.indexed, 0);
      await expectDuplicate(false, before, 0);
      assert.match(JSON.stringify(storedSignature()), /matcherVersion\\?":4/);
      watcher = indexer.startWatcher(512);
      await watcher.ready;
    });

    it('keeps the prior snapshot on EACCES and recovers on the next metadata event', async () => {
      await startIndex();
      const before = retainedSnapshot();
      const signature = storedSignature();
      vi.mocked(embedder.embedDetailed).mockClear();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const read = fs.readFileSync;
      const fault = vi.spyOn(fs, 'readFileSync').mockImplementation((...args) => {
        if (String(args[0]) === fixture.exclude) {
          throw Object.assign(new Error('permission denied: ' + fixture.exclude), {
            code: 'EACCES',
          });
        }
        return read(...args);
      });
      syncBuiltinESMExports();
      writeExclude('/projects/notes/duplicate/\n');
      await waitFor(() =>
        warn.mock.calls.flat().some((value) => String(value).includes(fixture.exclude)),
      );
      assert.deepEqual(storedSignature(), signature);
      assert.ok(indexedPaths().includes('duplicate/copy.md'));
      assert.deepEqual(retainedSnapshot(), before);
      assert.equal(vi.mocked(embedder.embedDetailed).mock.calls.length, 0);
      fault.mockRestore();
      syncBuiltinESMExports();
      writeExclude('# retry\n/projects/notes/duplicate/\n');
      await expectDuplicate(false, before, 0);
      assert.notDeepEqual(storedSignature(), signature);
    });

    it('does not recursively observe unrelated repository or Git object trees', async () => {
      for (let i = 0; i < 80; i++) {
        mkdirSync(path.join(fixture.commonDir, 'objects', 'unrelated-' + i), { recursive: true });
        fixture.write('unrelated/d' + i + '/other.md', '# unrelated');
      }
      const readdir = vi.spyOn(fsPromises, 'readdir');
      const osWatch = vi.spyOn(fs, 'watch');
      syncBuiltinESMExports();
      await startIndex();
      const visited = readdir.mock.calls.map(([file]) => String(file));
      assert.ok(
        !visited.some((file) => file.startsWith(path.join(fixture.commonDir, 'objects'))),
        JSON.stringify(visited),
      );
      assert.ok(
        !visited.some((file) => file.startsWith(path.join(fixture.repo, 'unrelated'))),
        JSON.stringify(visited),
      );
      const outsideVault = osWatch.mock.calls.filter(
        ([file]) => !String(file).startsWith(fixture.vault),
      );
      assert.deepEqual(
        outsideVault
          .map(([file]) => path.resolve(String(file)).normalize('NFD'))
          .filter((file) => file !== path.dirname(fixture.vault).normalize('NFD')),
        [],
        'metadata polling must not add native observation of repository or Git directories',
      );
      const policy = await import('../src/vault/ignore.js');
      const build = vi.spyOn(policy, 'createIgnorePolicy');
      vi.mocked(embedder.embedDetailed).mockClear();
      writeFileSync(
        path.join(fixture.commonDir, 'objects', 'unrelated-0', 'blob'),
        'unrelated activity',
      );
      fixture.write('unrelated/d0/other.md', '# still unrelated');
      await wait(1500);
      assert.equal(build.mock.calls.length, 0);
      assert.equal(vi.mocked(embedder.embedDetailed).mock.calls.length, 0);
    });
    it('retargets the exact exclude subscription after commondir changes', async () => {
      await startIndex();
      const before = retainedSnapshot();
      vi.mocked(embedder.embedDetailed).mockClear();
      const { resolveGitContext } = await import('../src/vault/git-context.js');
      const context = resolveGitContext(fixture.vault)!;
      const alternate = path.join(fixture.root, 'alternate.git');
      fixture.git(['init', '--bare', '--quiet', alternate]);
      const nextExclude = path.join(alternate, 'info', 'exclude');
      writeFileSync(nextExclude, '/projects/notes/duplicate/\n');
      writeFileSync(
        path.join(context.gitDirPath, 'commondir'),
        path.relative(context.gitDirPath, alternate) + '\n',
      );
      await expectDuplicate(false, before, 0);
      assert.equal(
        fs.realpathSync.native(
          fixture.git(['rev-parse', '--path-format=absolute', '--git-common-dir']),
        ),
        alternate,
      );
      writeFileSync(nextExclude, '# new target admits duplicate\n');
      await expectDuplicate(true, before, 1);
      const policy = await import('../src/vault/ignore.js');
      const build = vi.spyOn(policy, 'createIgnorePolicy');
      writeExclude('/projects/notes/duplicate/\n');
      await wait(1500);
      assert.equal(build.mock.calls.length, 0, 'old common directory is no longer a policy input');
      assert.ok(indexedPaths().includes('duplicate/copy.md'));
    });
    if (linked) {
      it('restores the known gitfile after deletion and retires its watch on close', async () => {
        await startIndex();
        const before = retainedSnapshot();
        vi.mocked(embedder.embedDetailed).mockClear();
        const rule = '/projects/notes/duplicate/\n/projects/notes/rescued/\n';
        writeExclude(rule);
        await expectDuplicate(false, before, 0);
        const gitfile = path.join(fixture.repo, '.git');
        const pointer = fs.readFileSync(gitfile, 'utf8');
        unlinkSync(gitfile);
        await expectDuplicate(true, before, 1);

        const policy = await import('../src/vault/ignore.js');
        const build = vi.spyOn(policy, 'createIgnorePolicy');
        writeExclude('# inactive without the gitfile\n' + rule);
        await wait(1500);
        assert.equal(build.mock.calls.length, 0, 'only the missing locator stays subscribed');
        writeFileSync(gitfile, pointer);
        await expectDuplicate(false, before, 0);
        writeExclude('# restored repository admits duplicate\n');
        await expectDuplicate(true, before, 1);
        writeExclude(rule);
        await expectDuplicate(false, before, 0);

        unlinkSync(gitfile);
        await expectDuplicate(true, before, 1);
        await watcher!.close();
        watcher = undefined;
        const signature = storedSignature();
        build.mockClear();
        writeFileSync(gitfile, pointer);
        writeExclude('# after close\n' + rule);
        await wait(1500);
        assert.equal(build.mock.calls.length, 0, 'close releases the absent locator subscription');
        assert.deepEqual(storedSignature(), signature);
        await expectDuplicate(true, before, 0);
      });
    }
    it('uses the latest coalesced rule after waiting for the indexing lock', async () => {
      await startIndex();
      const before = retainedSnapshot();
      const signature = storedSignature();
      vi.mocked(embedder.embedDetailed).mockClear();
      let release!: () => void;
      const blocked = indexer.withIndexingDbLock(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      await Promise.resolve();
      writeExclude('/projects/notes/duplicate/\n');
      await wait(1400);
      writeExclude('# latest snapshot keeps duplicate\n');
      await wait(1400);
      assert.deepEqual(storedSignature(), signature);
      release();
      await blocked;
      await waitFor(() => JSON.stringify(storedSignature()).includes('latest snapshot'));
      await expectDuplicate(true, before, 0);
    });
    it('stops filesystem observation and pending policy work after close', async () => {
      await startIndex();
      const before = retainedSnapshot();
      const signature = storedSignature();
      vi.mocked(embedder.embedDetailed).mockClear();
      writeExclude('/projects/notes/duplicate/\n');
      await watcher!.close();
      watcher = undefined;
      fixture.write('projects/notes/retained.md', '# Changed after close');
      fixture.write('.gitignore', '*.md\n');
      await wait(1500);
      assert.deepEqual(storedSignature(), signature);
      assert.deepEqual(retainedSnapshot(), before);
      assert.ok(indexedPaths().includes('duplicate/copy.md'));
      assert.equal(vi.mocked(embedder.embedDetailed).mock.calls.length, 0);
    });
  });
}
