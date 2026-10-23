import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'vitest';

// Import from side-effect-free module (NOT from server.ts which calls main())
const { registerProcessHandlers } = await import('../src/runtime/process-resilience');

describe('registerProcessHandlers', () => {
  let originalListeners: {
    uncaught: NodeJS.UncaughtExceptionListener[];
    rejection: NodeJS.UnhandledRejectionListener[];
  };

  beforeEach(() => {
    originalListeners = {
      uncaught: process.listeners('uncaughtException'),
      rejection: process.listeners('unhandledRejection'),
    };
    for (const fn of originalListeners.uncaught) process.removeListener('uncaughtException', fn);
    for (const fn of originalListeners.rejection) process.removeListener('unhandledRejection', fn);
  });

  afterEach(() => {
    const currentUncaught = process.listeners('uncaughtException');
    const currentRejection = process.listeners('unhandledRejection');
    for (const fn of currentUncaught) {
      if (!originalListeners.uncaught.includes(fn)) process.removeListener('uncaughtException', fn);
    }
    for (const fn of currentRejection) {
      if (!originalListeners.rejection.includes(fn))
        process.removeListener('unhandledRejection', fn);
    }
    for (const fn of originalListeners.uncaught) process.on('uncaughtException', fn);
    for (const fn of originalListeners.rejection) process.on('unhandledRejection', fn);
  });

  it('adds uncaughtException handler', () => {
    const before = process.listenerCount('uncaughtException');
    registerProcessHandlers();
    const after = process.listenerCount('uncaughtException');
    assert.equal(after, before + 1, 'should add one uncaughtException handler');
  });

  it('adds unhandledRejection handler', () => {
    const before = process.listenerCount('unhandledRejection');
    registerProcessHandlers();
    const after = process.listenerCount('unhandledRejection');
    assert.equal(after, before + 1, 'should add one unhandledRejection handler');
  });
});
