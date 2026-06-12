import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpRuntime, createMcpServer, startMcpBackgroundServices } from './mcp-runtime.js';
import { registerProcessHandlers } from './process-resilience.js';

export async function runStdioMcpServer(): Promise<void> {
  const runtime = await createMcpRuntime();
  const server = createMcpServer(runtime);
  const transport = new StdioServerTransport();

  const cleanup = () => {
    process.exit(0);
  };

  transport.onclose = cleanup;
  process.stdin.on('close', cleanup);
  process.stdin.on('end', cleanup);

  if (process.stdin.closed) {
    cleanup();
  }

  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));

  registerProcessHandlers();

  await server.connect(transport);

  startMcpBackgroundServices(runtime);
}
