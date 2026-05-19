import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import http, {
  type IncomingMessage,
  type Server as NodeHttpServer,
  type ServerResponse,
} from 'node:http';
import { config } from './config.js';
import { createMcpRuntime, createMcpServer, startMcpBackgroundServices } from './mcp-runtime.js';
import { registerProcessHandlers } from './process-resilience.js';

export interface HttpMcpServerOptions {
  host: string;
  port: number;
  startBackgroundServices?: boolean;
}

export interface HttpMcpServerHandle {
  host: string;
  port: number;
  url: string;
  healthUrl: string;
  close(): Promise<void>;
}

interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: ReturnType<typeof createMcpServer>;
}

export async function runHttpMcpServer(
  options: HttpMcpServerOptions,
): Promise<HttpMcpServerHandle> {
  const runtime = await createMcpRuntime();
  const sessions = new Map<string, McpSession>();
  let actualPort = options.port;

  const nodeServer = http.createServer((req, res) => {
    void handleRequest(req, res).catch((err: unknown) => {
      writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const hostHeader = req.headers.host ?? `${options.host}:${actualPort}`;
    const url = new URL(req.url ?? '/', `http://${hostHeader}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      writeJson(res, 200, {
        ok: true,
        name: 'obsidian-hybrid-search',
        version: runtime.version,
        transport: 'streamable-http',
        vaultPath: config.vaultPath,
      });
      return;
    }

    if (url.pathname !== '/mcp') {
      writeJson(res, 404, { error: 'not found' });
      return;
    }

    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId === 'string') {
      const session = sessions.get(sessionId);
      if (!session) {
        writeJson(res, 404, { error: 'unknown MCP session' });
        return;
      }
      await session.transport.handleRequest(req, res);
      return;
    }

    if (req.method !== 'POST') {
      writeJson(res, 400, { error: 'missing MCP session id' });
      return;
    }

    const body = await readJsonBody(req);
    if (!isInitializeRequest(body)) {
      writeJson(res, 400, { error: 'missing MCP session id' });
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (initializedSessionId) => {
        sessions.set(initializedSessionId, { transport, server: mcpServer });
      },
      onsessionclosed: (closedSessionId) => {
        sessions.delete(closedSessionId);
      },
      enableDnsRebindingProtection: true,
      allowedHosts: allowedHosts(options.host, actualPort),
    });
    const mcpServer = createMcpServer(runtime);
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  await listen(nodeServer, options.host, options.port);
  const address = nodeServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('HTTP MCP server did not bind to a TCP address');
  }
  actualPort = address.port;

  if (options.startBackgroundServices) {
    startMcpBackgroundServices(runtime);
  }

  const url = `http://${options.host}:${actualPort}/mcp`;
  return {
    host: options.host,
    port: actualPort,
    url,
    healthUrl: `http://${options.host}:${actualPort}/health`,
    close: async () => {
      await Promise.allSettled([...sessions.values()].map((session) => session.server.close()));
      sessions.clear();
      await closeNodeServer(nodeServer);
    },
  };
}

export async function runHttpMcpServerCli(host: string, port: number): Promise<void> {
  registerProcessHandlers();
  const handle = await runHttpMcpServer({ host, port, startBackgroundServices: true });
  console.log(`[mcp-http] listening on ${handle.url}`);

  const shutdown = () => {
    void handle
      .close()
      .catch((err: unknown) => {
        console.error('[mcp-http] shutdown error:', err);
        process.exit(1);
      })
      .then(() => process.exit(0));
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

function listen(server: NodeHttpServer, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeNodeServer(server: NodeHttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function allowedHosts(host: string, port: number): string[] {
  return [host, `${host}:${port}`, `localhost:${port}`, `127.0.0.1:${port}`];
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
  }
  return JSON.parse(raw) as unknown;
}
