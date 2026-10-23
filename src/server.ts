#!/usr/bin/env node
// organize-imports-ignore
import './runtime/preflight.js';
import { runStdioMcpServer } from './transports/mcp-stdio-server.js';

async function main(): Promise<void> {
  await runStdioMcpServer();
}

main().catch((err) => {
  console.error('[server] fatal error:', err);
  process.exit(1);
});
