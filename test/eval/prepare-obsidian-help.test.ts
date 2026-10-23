import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

it('prepares exact LF blob bytes despite inherited CRLF checkout settings', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ohs-corpus-eol-'));
  const source = path.join(root, 'source');
  mkdirSync(path.join(source, 'en'), { recursive: true });
  const git = (...args: string[]): string =>
    // Git is a developer prerequisite; this fixture passes fixed arguments without a shell.
    execFileSync(
      // eslint-disable-next-line sonarjs/no-os-command-from-path
      'git',
      [
        '-C',
        source,
        '-c',
        'core.autocrlf=false',
        '-c',
        'core.eol=lf',
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { encoding: 'utf8' },
    ).trim();
  try {
    git('init', '-q');
    writeFileSync(path.join(source, '.gitattributes'), '* text=auto\n');
    writeFileSync(path.join(source, 'en/Hello.md'), 'hello\n');
    git('add', '.');
    git('commit', '-q', '-m', 'Pinned LF corpus');
    const revision = git('rev-parse', 'HEAD');
    // Only replace the remote manifest: preparation still runs real init/fetch/checkout
    // and validates working-tree bytes against Git blob identities, without network.
    vi.doMock('../../eval/obsidian-help-corpus.json', () => ({
      default: {
        repository: source,
        revision,
        files: { 'Hello.md': 'ce013625030ba8dba906f756967f9e9ca394464a' },
      },
    }));
    vi.resetModules();
    vi.stubEnv('GIT_CONFIG_COUNT', '2');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'core.autocrlf');
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'true');
    vi.stubEnv('GIT_CONFIG_KEY_1', 'core.eol');
    vi.stubEnv('GIT_CONFIG_VALUE_1', 'crlf');
    const { prepareObsidianHelpFixture: prepare } =
      await import('../../eval/prepare-obsidian-help.js');
    const vault = path.join(root, 'fixtures/dataset');
    expect(prepare({ repoRoot: root, vault }).copied).toBe(true);
    expect(readFileSync(path.join(vault, 'Hello.md'))).toEqual(Buffer.from('hello\n'));
  } finally {
    vi.unstubAllEnvs();
    vi.doUnmock('../../eval/obsidian-help-corpus.json');
    vi.resetModules();
    rmSync(root, { recursive: true, force: true });
  }
});
