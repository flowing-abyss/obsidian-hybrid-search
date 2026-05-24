#!/usr/bin/env node
// organize-imports-ignore
import './preflight.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpRuntime, createMcpServer, startMcpBackgroundServices } from './mcp-runtime.js';
import { registerProcessHandlers } from './process-resilience.js';

async function main(): Promise<void> {
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

main().catch((err) => {
  console.error('[server] fatal error:', err);
  process.exit(1);
});
