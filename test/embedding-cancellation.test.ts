import assert from 'node:assert/strict';
import { afterEach, it, vi } from 'vitest';
process.env.OPENAI_API_KEY = 'test';
process.env.OPENAI_BASE_URL = 'https://embedding.test/v1';
const { embedDetailed } = await import('../src/inference/embedder.js');
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
});
it('cancels an in-flight embedding without retries or fallback requests', async () => {
  const controller = new AbortController();
  let requested!: () => void;
  const started = new Promise<void>((resolve) => {
    requested = resolve;
  });
  const fetch = vi.fn(
    (_url: unknown, options: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('ownership changed')), {
          once: true,
        });
        requested();
      }),
  );
  vi.stubGlobal('fetch', fetch);
  const operation = embedDetailed(['one', 'two'], 'document', { signal: controller.signal });
  await started;
  controller.abort(new Error('ownership changed'));
  await assert.rejects(operation, /ownership changed/);
  assert.equal(fetch.mock.calls.length, 1);
}, 500);
it('never dispatches work for an already cancelled owner', async () => {
  process.env.OPENAI_API_KEY = 'test';
  process.env.OPENAI_BASE_URL = 'https://embedding.test/v1';
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await assert.rejects(
    embedDetailed(['text'], 'document', { signal: AbortSignal.abort(new Error('stopped')) }),
    /stopped/,
  );
  assert.equal(fetch.mock.calls.length, 0);
});
