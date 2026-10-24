import { serveStdio } from '@modelcontextprotocol/server/stdio';
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
  const connection = serveStdio(() => createMcpServer(runtime), {
    legacy: 'serve',
    onerror: (error) => console.error('[mcp-stdio] protocol error:', error),
  });

  let closing = false;
  const cleanup = () => {
    if (closing) return;
    closing = true;
    void Promise.allSettled([connection.close(), closeMcpRuntime(runtime)]).then((results) => {
      const failures = results.filter((result) => result.status === 'rejected');
      for (const failure of failures) console.error('[mcp-stdio] shutdown error:', failure.reason);
      closeDb();
      process.exit(failures.length ? 1 : 0);
    });
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
