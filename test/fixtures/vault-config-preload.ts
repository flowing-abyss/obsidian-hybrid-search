import { register } from 'node:module';

const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '[::1]') {
    return Promise.reject(
      new Error(`External fetch blocked in vault config fixture: ${url.origin}`),
    );
  }
  return originalFetch(input, init);
};

register(new URL('./download-progress-loader.js', import.meta.url), import.meta.url);
