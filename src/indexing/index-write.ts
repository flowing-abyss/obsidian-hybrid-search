import { setTimeout as delay } from 'node:timers/promises';
import type { IndexRunContext } from './index-owner.js';

/** Retry only SQLite lock contention. Keep prepared embeddings outside the transaction. */
export async function retryIndexWrite<T>(
  run: IndexRunContext,
  operation: () => T | Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    run.signal.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      const busy =
        !!error &&
        typeof error === 'object' &&
        'code' in error &&
        (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED');
      if (!busy || attempt >= 3) throw error;
      await delay([50, 150, 450][attempt], undefined, { signal: run.signal });
    }
  }
}
