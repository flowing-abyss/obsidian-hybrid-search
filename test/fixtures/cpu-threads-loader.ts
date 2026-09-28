import type { ResolveHook } from 'node:module';

const model = `
import fs from 'node:fs';
import path from 'node:path';
export const env = {};
export async function pipeline(_task, _name, options) {
  const preference = path.join(process.env.XDG_CACHE_HOME, 'obsidian-hybrid-search', 'inference-settings.json');
  fs.appendFileSync(process.env.OHS_TEST_THREAD_LOG, JSON.stringify({
    persisted: fs.existsSync(preference) ? JSON.parse(fs.readFileSync(preference, 'utf8')) : null,
    session: options.session_options ?? null,
  }) + '\\n');
  return Object.assign(async () => ({ data: new Float32Array([1, 0]) }), {
    tokenizer: { model_max_length: 512, encode: () => [1, 2] },
    model: { config: { max_position_embeddings: 512 } },
  });
}
`;

export const resolve: ResolveHook = (specifier, context, nextResolve) => {
  if (specifier === '@huggingface/transformers') {
    return { url: `data:text/javascript,${encodeURIComponent(model)}`, shortCircuit: true };
  }
  return nextResolve(specifier, context);
};
