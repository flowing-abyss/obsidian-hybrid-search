#!/usr/bin/env node
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { assertEvalQuality } from '../eval/quality.ts';
import { localModelEnv, runNpm } from './run-command.mjs';

const env = localModelEnv();
// Evaluation selects the entire pinned corpus, independently of personal vault settings.
// Keep this policy local to the quality gate; runtime commands retain user filters.
for (const name of Object.keys(env)) {
  if (name.startsWith('OBSIDIAN_')) delete env[name];
}
env.OBSIDIAN_INCLUDE_PATTERNS = '';
env.OBSIDIAN_IGNORE_PATTERNS = '';
env.OBSIDIAN_RESPECT_GITIGNORE = 'false';
const modes = [false, true].map((rerank) => ({
  rerank,
  output: `eval/results/.tmp-quality-${rerank ? 'rerank' : 'no-rerank'}.json`,
}));
try {
  mkdirSync('eval/results', { recursive: true });
  for (const { output } of modes) rmSync(output, { force: true });
  process.exitCode = runNpm(['run', 'eval:prepare-obsidian-help'], { env });
  if (process.exitCode === 0) {
    for (const { rerank, output } of modes) {
      const status = runNpm(
        [
          'run',
          'eval',
          '--',
          '--vault',
          'fixtures/obsidian-help/dataset',
          '--output',
          output,
          ...(rerank ? ['--rerank'] : []),
        ],
        { env },
      );
      if (status !== 0) {
        process.exitCode = status;
        break;
      }
      const result = JSON.parse(readFileSync(output, 'utf8'));
      const meta = result.meta;
      if (
        meta.rerank !== rerank ||
        meta.model !== env.LOCAL_EMBEDDING_MODEL ||
        meta.rerank_model !== (rerank ? env.RERANKER_MODEL : null) ||
        meta.note_count !== 171 ||
        meta.golden_set_size !== 58 ||
        meta.k !== 10
      ) {
        throw new Error(`Unexpected evaluation metadata in ${output}`);
      }
      assertEvalQuality(result);
      console.log(`[eval:quality] ${output}: floors passed`);
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
