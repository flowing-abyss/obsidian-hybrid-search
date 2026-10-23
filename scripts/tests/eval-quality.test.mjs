import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
const runner = fileURLToPath(new URL('../eval-quality.mjs', import.meta.url));
const tsx = new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url).href;
function fixture(run) {
  const root = mkdtempSync(path.join(tmpdir(), 'ohs-quality-'));
  try {
    mkdirSync(path.join(root, 'eval/results'), { recursive: true });
    const npm = path.join(root, 'npm.cjs');
    writeFileSync(
      npm,
      `const fs=require('node:fs'); const args=process.argv.slice(2); fs.appendFileSync('calls',JSON.stringify({args,env:process.env})+'\\n'); if(args[1]==='eval'){ if(process.env.FAIL)process.exit(39); if(!process.env.MISSING){ const rerank=args.includes('--rerank'); const output=args[args.indexOf('--output')+1]; fs.writeFileSync(output,JSON.stringify({meta:{rerank:process.env.WRONG? !rerank:rerank,model:process.env.LOCAL_EMBEDDING_MODEL,rerank_model:rerank?process.env.RERANKER_MODEL:null,note_count:171,golden_set_size:58,k:10},summary:{ndcg_5:1,mrr:1,hit_1:1,hit_3:1,hit_5:1}})); }} `,
    );
    run(root, (extra = {}) =>
      spawnSync(process.execPath, ['--import', tsx, runner], {
        cwd: root,
        env: {
          ...process.env,
          npm_execpath: npm,
          OPENAI_API_KEY: 'must-be-cleared',
          OPENAI_BASE_URL: 'https://invalid.example',
          LOCAL_EMBEDDING_MODEL: 'wrong',
          ...extra,
        },
        encoding: 'utf8',
      }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
test('fresh quality evaluates both modes locally and retains their outputs', () =>
  fixture((root, run) => {
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(path.join(root, 'calls'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.filter(({ args }) => args[1] === 'eval').length, 2);
    for (const { env } of calls) {
      assert.equal(env.OPENAI_API_KEY, undefined);
      assert.equal(env.OPENAI_BASE_URL, undefined);
      assert.equal(env.LOCAL_EMBEDDING_MODEL, 'Xenova/multilingual-e5-small');
    }
    for (const mode of ['no-rerank', 'rerank'])
      assert.equal(existsSync(path.join(root, `eval/results/.tmp-quality-${mode}.json`)), true);
  }));
test('failed evaluation preserves the failure and removes stale outputs from both modes', () =>
  fixture((root, run) => {
    for (const mode of ['no-rerank', 'rerank'])
      writeFileSync(path.join(root, `eval/results/.tmp-quality-${mode}.json`), 'stale');
    assert.equal(run({ FAIL: '1' }).status, 39);
    for (const mode of ['no-rerank', 'rerank'])
      assert.equal(existsSync(path.join(root, `eval/results/.tmp-quality-${mode}.json`)), false);
  }));
test('missing output and incorrect mode metadata fail quality', () =>
  fixture((_root, run) => {
    assert.notEqual(run({ MISSING: '1' }).status, 0);
    assert.notEqual(run({ WRONG: '1' }).status, 0);
  }));

test('pinned corpus evaluation ignores inherited personal vault selection', () =>
  fixture((root, run) => {
    const result = run({
      OBSIDIAN_VAULT_PATH: '/personal/vault',
      OBSIDIAN_PREFIX: 'private_',
      OBSIDIAN_INCLUDE_PATTERNS: 'private/**',
      OBSIDIAN_IGNORE_PATTERNS: '**/*.md',
      OBSIDIAN_RESPECT_GITIGNORE: 'true',
    });
    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(path.join(root, 'calls'), 'utf8').trim().split('\n').map(JSON.parse);
    const evaluations = calls.filter(({ args }) => args[1] === 'eval');
    assert.equal(evaluations.length, 2);
    for (const { args, env } of evaluations) {
      assert.equal(args[args.indexOf('--vault') + 1], 'fixtures/obsidian-help/dataset');
      assert.equal(env.OBSIDIAN_INCLUDE_PATTERNS, '');
      assert.equal(env.OBSIDIAN_IGNORE_PATTERNS, '');
      assert.equal(env.OBSIDIAN_RESPECT_GITIGNORE, 'false');
      assert.equal(env.OBSIDIAN_VAULT_PATH, undefined);
      assert.equal(env.OBSIDIAN_PREFIX, undefined);
    }
  }));
