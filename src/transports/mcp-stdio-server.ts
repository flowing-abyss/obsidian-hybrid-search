import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { registerProcessHandlers } from '../runtime/process-resilience.js';
import { closeDb } from '../storage/db.js';
import {
  closeMcpRuntime,
  createMcpRuntime,
  createMcpServer,
  startMcpBackgroundServices,
} from './mcp-runtime.js';

export async function runStdioMcpServer(): Promise<void> {
  const runtime = await createMcpRuntime();
  const transport = new StdioServerTransport();
  const connection = serveStdio(() => createMcpServer(runtime), {
    legacy: 'serve',
    transport,
    onerror: (error) => console.error('[mcp-stdio] protocol error:', error),
  });

  let closing = false;
  let transportFailed = false;
  const cleanup = () => {
    if (closing) return;
    closing = true;
    void Promise.allSettled([connection.close(), closeMcpRuntime(runtime)]).then((results) => {
      const failures = results.filter((result) => result.status === 'rejected');
      for (const failure of failures) console.error('[mcp-stdio] shutdown error:', failure.reason);
      closeDb();
      process.exit(failures.length || transportFailed ? 1 : 0);
    });
  };

  // The SDK can close the wire without stdin EOF (for example on overflow).
  // Preserve its connection cleanup, then stop this runtime's background work.
  const sdkOnClose = transport.onclose;
  transport.onclose = () => {
    try {
      sdkOnClose?.();
    } finally {
      transportFailed = !closing && !process.stdin.readableEnded && !process.stdin.closed;
      cleanup();
    }
  };

  process.stdin.on('close', cleanup);
  process.stdin.on('end', cleanup);

  if (process.stdin.closed) {
    cleanup();
    return;
  }

  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);

  registerProcessHandlers();

  startMcpBackgroundServices(runtime);
}
