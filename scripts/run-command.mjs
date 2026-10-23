import { spawnSync } from 'node:child_process';
import { constants } from 'node:os';

export function runNpm(args, options = {}) {
  if (!process.env.npm_execpath) throw new Error('Run this command through npm run');
  const result = spawnSync(process.execPath, [process.env.npm_execpath, ...args], {
    stdio: 'inherit',
    ...options,
  });
  if (result.error) console.error(result.error.message);
  if (result.signal) console.error(`Command cancelled by ${result.signal}`);
  return result.status ?? (result.signal ? 128 + (constants.signals[result.signal] ?? 1) : 1);
}

export function localModelEnv(source = process.env) {
  const env = { ...source };
  for (const name of Object.keys(env)) {
    if (name.startsWith('OPENAI_') || name.startsWith('RERANKER_')) delete env[name];
  }
  env.LOCAL_EMBEDDING_MODEL = 'Xenova/multilingual-e5-small';
  env.RERANKER_MODEL = 'onnx-community/gte-multilingual-reranker-base';
  return env;
}
