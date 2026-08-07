import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import http, {
  type IncomingMessage,
  type Server as NodeHttpServer,
  type ServerResponse,
} from 'node:http';
import { config } from './config.js';
import { closeDb } from './db.js';
import { createMcpRuntime, createMcpServer, startMcpBackgroundServices } from './mcp-runtime.js';
import { registerProcessHandlers } from './process-resilience.js';

export interface HttpMcpServerOptions {
  host: string;
  port: number;
  allowedHosts?: string[];
  allowAnyHost?: boolean;
  startBackgroundServices?: boolean;
}

export interface HttpMcpServerHandle {
  host: string;
  port: number;
  url: string;
  healthUrl: string;
  close(): Promise<void>;
}

export async function runHttpMcpServer(
  options: HttpMcpServerOptions,
): Promise<HttpMcpServerHandle> {
  const runtime = await createMcpRuntime();
  let actualPort = options.port;

  const nodeServer = http.createServer((req, res) => {
    void handleRequest(req, res).catch((err: unknown) => {
      writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const hostHeader = req.headers.host ?? `${options.host}:${actualPort}`;
    if (!isAllowedHostHeader(hostHeader, options.host, actualPort, options)) {
      writeJson(res, 403, { error: 'Invalid Host header' });
      return;
    }
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

    if (req.method !== 'POST') {
      writeJson(res, 405, { error: 'method not allowed' });
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableDnsRebindingProtection: options.allowAnyHost !== true,
      allowedHosts: allowedHosts(options.host, actualPort, options.allowedHosts),
    });
    const mcpServer = createMcpServer(runtime);
    res.once('close', () => {
      void Promise.allSettled([transport.close(), mcpServer.close()]);
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
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
      await closeNodeServer(nodeServer);
      closeDb();
    },
  };
}

export async function runHttpMcpServerCli(options: {
  host: string;
  port: number;
  allowedHosts?: string[];
  allowAnyHost?: boolean;
}): Promise<void> {
  registerProcessHandlers();
  const handle = await runHttpMcpServer({ ...options, startBackgroundServices: true });
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

function isAllowedHostHeader(
  hostHeader: string,
  host: string,
  port: number,
  options: Pick<HttpMcpServerOptions, 'allowedHosts' | 'allowAnyHost'>,
): boolean {
  if (options.allowAnyHost === true) return true;
  return allowedHosts(host, port, options.allowedHosts).includes(hostHeader.trim());
}

export function normalizeAllowedHosts(hosts: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const host of hosts ?? []) {
    const value = host.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

function allowedHosts(
  host: string,
  port: number,
  extraHosts: readonly string[] | undefined,
): string[] {
  return normalizeAllowedHosts(
    [host, 'localhost', '127.0.0.1', ...normalizeAllowedHosts(extraHosts)].flatMap((allowedHost) =>
      expandAllowedHostForPort(allowedHost, port),
    ),
  );
}

function expandAllowedHostForPort(host: string, port: number): string[] {
  if (hasExplicitPort(host)) return [host];
  return [host, `${host}:${port}`];
}

function hasExplicitPort(host: string): boolean {
  if (host.startsWith('[')) return /\]:\d+$/.test(host);
  const colonMatches = host.match(/:/g);
  return colonMatches?.length === 1 && /:\d+$/.test(host);
}
