import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
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
  const server = createMcpServer(runtime);
  const transport = new StdioServerTransport();

  let closing = false;
  const cleanup = () => {
    if (closing) return;
    closing = true;
    void closeMcpRuntime(runtime).finally(() => {
      closeDb();
      process.exit(0);
    });
  };

  transport.onclose = cleanup;
  process.stdin.on('close', cleanup);
  process.stdin.on('end', cleanup);

  if (process.stdin.closed) {
    cleanup();
  }

  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);

  registerProcessHandlers();

  await server.connect(transport);

  startMcpBackgroundServices(runtime);
}
