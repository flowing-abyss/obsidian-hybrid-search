import { execFileSync, spawnSync } from 'node:child_process';
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

export function verificationEnv(source = process.env) {
  const env = localModelEnv(source);
  // Git hooks export repository locations. Fixture Git commands must use their
  // own cwd, as documented in git-hooks' guidance for foreign repositories.
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- Git is a developer prerequisite; arguments are fixed and no shell is used.
  const names = execFileSync('git', ['rev-parse', '--local-env-vars'], {
    env: source,
    encoding: 'utf8',
  })
    .split(/\r?\n/)
    .filter(Boolean);
  const localNames = new Set(names.map((name) => name.toUpperCase()));
  for (const name of Object.keys(env)) {
    // A cloned Windows environment is a plain object but child-process lookup
    // remains case-insensitive. Remove every spelling of a repository override.
    const normalized = name.toUpperCase();
    if (localNames.has(normalized) || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(normalized)) {
      delete env[name];
    }
  }
  return env;
}
