#!/usr/bin/env node
// organize-imports-ignore
import './preflight.js';
import { runStdioMcpServer } from './mcp-stdio-server.js';

async function main(): Promise<void> {
  await runStdioMcpServer();
}

main().catch((err) => {
  console.error('[server] fatal error:', err);
  process.exit(1);
});
