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
  assertHttpBindingSecurity,
  createBearerValidator,
  formatHttpHost,
  isSameOrigin,
  normalizeHttpAuthority,
  readHttpAuthToken,
} from './mcp-http-security.js';
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
  const authToken = readHttpAuthToken();
  assertHttpBindingSecurity(options.host, options.allowAnyHost, authToken);
  const hasValidBearer = createBearerValidator(authToken);
  const runtime = await createMcpRuntime();
  let actualPort = options.port;
  const reportError = (error: Error) => console.error('[mcp-http] request error:', error);
  const handler = createMcpHandler(() => createMcpServer(runtime), {
    legacy: 'stateless',
    onerror: reportError,
  });
  const serveRequest = toNodeHandler(handler, { onerror: reportError });

  let activeRequests = 0;
  const nodeServer = http.createServer(
    { headersTimeout: 10_000, requestTimeout: 30_000, connectionsCheckingInterval: 1000 },
    (req, res) => {
      void handleRequest(req, res).catch((err: unknown) => {
        console.error('[mcp-http] request error:', err);
        writeJson(res, 500, { error: 'Internal server error' });
      });
    },
  );
  nodeServer.maxConnections = 128;

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const hostHeader = req.headers.host;
    if (!hostHeader || req.headersDistinct.host?.length !== 1) {
      writeJson(res, 400, { error: 'Missing or duplicate Host header' });
      return;
    }
    if (!isAllowedHostHeader(hostHeader, options.host, actualPort, options)) {
      writeJson(res, 403, { error: 'Invalid Host header' });
      return;
    }
    if (req.headersDistinct.origin && req.headersDistinct.origin.length !== 1) {
      writeJson(res, 403, { error: 'Invalid Origin header' });
      return;
    }
    if (!isSameOrigin(req.headers.origin, hostHeader)) {
      writeJson(res, 403, { error: 'Invalid Origin header' });
      return;
    }
    if (
      (authToken !== undefined && req.headersDistinct.authorization?.length !== 1) ||
      !hasValidBearer(req.headers.authorization)
    ) {
      writeJson(
        res,
        401,
        { error: 'Bearer authentication required' },
        {
          'www-authenticate': 'Bearer realm="obsidian-hybrid-search"',
        },
      );
      return;
    }
    const requestTarget = req.url ?? '/';
    if (!requestTarget.startsWith('/') || /^[/\\]{2}/.test(requestTarget)) {
      writeJson(res, 400, { error: 'Invalid request target' });
      return;
    }
    const url = new URL(requestTarget, `http://${hostHeader}`);

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

    if (activeRequests >= 32) {
      writeJson(
        res,
        429,
        { error: 'Too many concurrent requests; retry later' },
        {
          'retry-after': '1',
          connection: 'close',
        },
      );
      return;
    }
    activeRequests += 1;
    try {
      // The SDK bounds both Content-Length and streamed bodies to 4 MiB. The
      // admission cap also bounds aggregate buffering before JSON is parsed.
      await serveRequest(req, res);
    } finally {
      activeRequests -= 1;
    }
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

  const authority = `${formatHttpHost(options.host)}:${actualPort}`;
  const url = `http://${authority}/mcp`;
  let closing: Promise<void> | undefined;
  return {
    host: options.host,
    port: actualPort,
    url,
    healthUrl: `http://${authority}/health`,
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
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function isAllowedHostHeader(
  hostHeader: string,
  host: string,
  port: number,
  options: Pick<HttpMcpServerOptions, 'allowedHosts' | 'allowAnyHost'>,
): boolean {
  const authority = normalizeHttpAuthority(hostHeader);
  if (authority === null) return false;
  if (options.allowAnyHost === true) return true;
  return allowedHosts(host, port, options.allowedHosts).some(
    (allowed) => normalizeHttpAuthority(allowed) === authority,
  );
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
    [
      formatHttpHost(host),
      'localhost',
      '127.0.0.1',
      '[::1]',
      ...normalizeAllowedHosts(extraHosts),
    ].flatMap((allowedHost) => expandAllowedHostForPort(allowedHost, port)),
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
