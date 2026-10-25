import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, it, vi } from 'vitest';

const vault = mkdtempSync(path.join(tmpdir(), 'ohs-reindex-progress-'));
vi.stubEnv('OBSIDIAN_VAULT_PATH', vault);
vi.stubEnv('OBSIDIAN_IGNORE_PATTERNS', '');
vi.stubEnv('OBSIDIAN_INCLUDE_PATTERNS', '');
vi.stubEnv('OBSIDIAN_CONTENT_IGNORE_PATTERNS', '');
vi.stubEnv('OBSIDIAN_RESPECT_GITIGNORE', 'false');
const db = await import('./helpers/owned-storage.js');
const embedder = await import('../src/inference/embedder.js');
const { config } = await import('../src/runtime/config.js');
const { createIndexService } = await import('../src/indexing/index-service.js');
const originalBatchSize = config.batchSize;
const originalTTY = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
let service: ReturnType<typeof createIndexService>;
let output: string;

beforeEach(() => {
  mkdirSync(vault, { recursive: true });
  db.openDb();
  db.initVecTable(4);
  config.batchSize = 2;
  vi.spyOn(embedder, 'activeModelName').mockReturnValue('progress-model');
  vi.spyOn(embedder, 'getEmbeddingDim').mockResolvedValue(4);
  vi.spyOn(embedder, 'getContextLength').mockResolvedValue(512);
  vi.spyOn(embedder, 'getDocumentTokenPolicy').mockResolvedValue({
    limit: 508,
    count: (text) => text.length / 4,
  });
  vi.spyOn(embedder, 'embedDetailed').mockImplementation((texts) =>
    Promise.resolve(
      texts.map(() => ({ ok: true as const, embedding: new Float32Array([1, 0, 0, 0]) })),
    ),
  );
  output = '';
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    output += Buffer.from(chunk).toString('utf8');
    return true;
  });
  service = createIndexService();
});

afterEach(async () => {
  await service.close();
  db.closeDb();
  vi.restoreAllMocks();
  config.batchSize = originalBatchSize;
  if (originalTTY) Object.defineProperty(process.stderr, 'isTTY', originalTTY);
  else Reflect.deleteProperty(process.stderr, 'isTTY');
  rmSync(vault, { recursive: true, force: true });
});
afterAll(() => vi.unstubAllEnvs());

function notes(count: number, directory = vault): void {
  for (let index = 0; index < count; index++) {
    writeFileSync(
      path.join(directory, `note-${index}.md`),
      `# Planet ${index}\nPlanets orbit stars. Telescope observations reveal their atmospheres.\n`,
    );
  }
}

it.each([
  { force: false, tty: true },
  { force: true, tty: true },
  { force: false, tty: false },
  { force: true, tty: false },
])('reports live counts and ETA with force=$force and tty=$tty', async ({ force, tty }) => {
  process.stderr.isTTY = tty;
  notes(10);
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  let completed = 0;
  let initial = '';
  let halfway = '';
  vi.mocked(embedder.embedDetailed).mockImplementation((texts) => {
    if (completed === 0) initial = output;
    // Capture the real output before the fourth batch can finish.
    if (completed === 6) halfway = output;
    completed++;
    now += 2000;
    return Promise.resolve(
      texts.map(() => ({ ok: true as const, embedding: new Float32Array([1, 0, 0, 0]) })),
    );
  });

  const result = await service.reindex({ force });
  assert.equal(result.indexed, 10);
  assert.equal(db.getStats().total, 10);
  assert.match(halfway, /6\/10/);
  assert.match(halfway, /60%/);
  assert.match(halfway, /8s remaining/);
  assert.doesNotMatch(halfway, /Done/);
  assert.match(output, /100%/);
  assert.match(output, /10\/10/);
  const completion = output
    .split(/[\r\n]/)
    .reverse()
    .find((line) => line.includes('100%'));
  assert.ok(completion);
  assert.ok(!completion.includes('remaining'));
  if (tty) {
    assert.match(initial, /0% \(0\/10 notes\)/);
    assert.ok(output.includes('\r\x1b[2K'));
  } else {
    for (const control of ['\r', '\x1b', '█', '░']) assert.ok(!output.includes(control));
    assert.match(output, /10\/10 \(100%\)\n/);
  }
});

it.each(['embedding', 'publication'] as const)(
  'ends the progress line without claiming success after a %s failure',
  async (failure) => {
    process.stderr.isTTY = true;
    notes(2);
    await service.reindex();
    const previous = db.getNoteByPath('note-0.md')!.content;
    output = '';
    if (failure === 'embedding') {
      vi.mocked(embedder.embedDetailed).mockRejectedValue(new Error('embedding rejected'));
    } else {
      db.getDb().exec(
        "CREATE TRIGGER fail_publish BEFORE INSERT ON notes BEGIN SELECT RAISE(ABORT,'publication rejected'); END",
      );
    }
    await assert.rejects(service.reindex({ force: true }), /rejected/);
    assert.match(output, /0% \(0\/2 notes\)/);
    assert.ok(output.endsWith('\n'), 'failure must leave diagnostics on a fresh line');
    assert.doesNotMatch(output, /Done/);
    assert.equal(db.getNoteByPath('note-0.md')!.content, previous);
  },
);

it('starts a fresh progress pass when files appear during a full rebuild', async () => {
  process.stderr.isTTY = true;
  notes(2);
  vi.mocked(embedder.embedDetailed).mockImplementationOnce((texts) => {
    writeFileSync(path.join(vault, 'added.md'), 'A new note added while embedding the vault.');
    return Promise.resolve(
      texts.map(() => ({ ok: true as const, embedding: new Float32Array([1, 0, 0, 0]) })),
    );
  });
  const result = await service.reindex({ force: true });
  assert.equal(result.indexed, 3);
  assert.match(output, /0% \(0\/2 notes\)/);
  const lines = output.split('\n');
  const restart = lines.findIndex((line) => line.includes('0% (0/3 notes)'));
  assert.ok(restart > 0);
  const header = lines[restart - 1];
  assert.ok(header);
  assert.ok(!header.includes('%'), 'the next pass header needs a fresh line');
  assert.match(output, /100% \(3\/3 notes\)/);
  assert.equal(output.match(/Done/g)?.length, 1);
  assert.equal(db.getStats().total, 3);
});

it('completes an empty full rebuild without invalid percentages or time estimates', async () => {
  process.stderr.isTTY = true;
  const result = await service.reindex({ force: true });
  assert.equal(result.indexed, 0);
  assert.match(output, /0 notes indexed/);
  assert.doesNotMatch(output, /NaN|Infinity|remaining/);
});

it.each([false, true])('shows progress through the CLI with force=%s', (force) => {
  const cliVault = path.join(vault, 'cli');
  mkdirSync(cliVault);
  notes(25, cliVault);
  const root = fileURLToPath(new URL('../', import.meta.url));
  const preload = new URL('../dist/test/fixtures/download-progress-preload.js', import.meta.url);
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      preload.href,
      path.join(root, 'dist/src/cli.js'),
      'reindex',
      ...(force ? ['--force'] : []),
    ],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        OBSIDIAN_VAULT_PATH: cliVault,
        XDG_CACHE_HOME: path.join(vault, '.cache'),
        OPENAI_API_KEY: '',
        OPENAI_BASE_URL: '',
        OPENAI_EMBEDDING_MODEL: '',
        LOCAL_EMBEDDING_MODEL: 'Xenova/multilingual-e5-small',
        OHS_TEST_PIPE: '0',
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /0% \(0\/25 notes\)/);
  assert.match(result.stderr, /40% \(10\/25 notes\)/);
  assert.match(result.stderr, /100% \(25\/25 notes\)/);
});
