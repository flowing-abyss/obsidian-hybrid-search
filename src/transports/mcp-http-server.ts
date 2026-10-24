import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import http, {
  type IncomingMessage,
  type Server as NodeHttpServer,
  type ServerResponse,
} from 'node:http';
import { config } from '../runtime/config.js';
import { registerProcessHandlers } from '../runtime/process-resilience.js';
import { closeDb } from '../storage/db.js';
import {
  closeMcpRuntime,
  createMcpRuntime,
  createMcpServer,
  startMcpBackgroundServices,
} from './mcp-runtime.js';

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
  const reportError = (error: Error) => console.error('[mcp-http] request error:', error);
  const handler = createMcpHandler(() => createMcpServer(runtime), {
    legacy: 'stateless',
    onerror: reportError,
  });
  const serveRequest = toNodeHandler(handler, { onerror: reportError });

  const nodeServer = http.createServer((req, res) => {
    void handleRequest(req, res).catch((err: unknown) => {
      console.error('[mcp-http] request error:', err);
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
      // Stateless Streamable HTTP only answers POST: there is no SSE stream to
      // GET and no session to DELETE. RFC 9110 requires Allow on every 405.
      writeJson(res, 405, { error: 'method not allowed' }, { allow: 'POST' });
      return;
    }

    if (!req.headers.host) {
      writeJson(res, 400, { error: 'Missing Host header' });
      return;
    }
    await serveRequest(req, res);
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
  let closing: Promise<void> | undefined;
  return {
    host: options.host,
    port: actualPort,
    url,
    healthUrl: `http://${options.host}:${actualPort}/health`,
    close: () => {
      closing ??= (async () => {
        const results = await Promise.allSettled([
          closeNodeServer(nodeServer),
          closeMcpRuntime(runtime),
        ]);
        // Let connected clients receive admitted results before closing their
        // SDK transports. This server does not advertise persistent subscriptions.
        results.push(...(await Promise.allSettled([handler.close()])));
        closeDb();
        const errors = results.flatMap((result): unknown[] =>
          result.status === 'rejected' ? [result.reason] : [],
        );
        if (errors.length) throw new AggregateError(errors, 'MCP HTTP shutdown failed');
      })();
      return closing;
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

function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders });
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
