import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

export interface McpState {
  pid: number;
  host: string;
  port: number;
  url: string;
  healthUrl: string;
  logPath: string;
  vaultPath: string;
  startedAt: string;
}

export interface McpPaths {
  dir: string;
  statePath: string;
  logPath: string;
}

export interface EnsureMcpOptions {
  host: string;
  port: number;
  healthTimeoutMs?: number;
}

export interface EnsureMcpResult {
  state: McpState;
  started: boolean;
}

export function getMcpPaths(): McpPaths {
  const cacheHome = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  const dir = path.join(cacheHome, 'obsidian-hybrid-search');
  return {
    dir,
    statePath: path.join(dir, 'mcp-state.json'),
    logPath: path.join(dir, 'mcp.log'),
  };
}

export function buildMcpUrls(host: string, port: number): { url: string; healthUrl: string } {
  return {
    url: `http://${host}:${port}/mcp`,
    healthUrl: `http://${host}:${port}/health`,
  };
}

export function readMcpState(): McpState | null {
  const { statePath } = getMcpPaths();
  if (!existsSync(statePath)) return null;

  try {
    return JSON.parse(readFileSync(statePath, 'utf-8')) as McpState;
  } catch {
    return null;
  }
}

export function writeMcpState(state: McpState): void {
  const { dir, statePath } = getMcpPaths();
  mkdirSync(dir, { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

export function removeMcpState(): void {
  rmSync(getMcpPaths().statePath, { force: true });
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isPortAvailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => {
      resolve(false);
    });
    server.listen(port, host, () => {
      server.close(() => {
        resolve(true);
      });
    });
  });
}

export function formatPortConflictError(port: number): string {
  return `Port ${port} is already in use.

Another MCP server may already be running, or another app is using this port.
Run:

  obsidian-hybrid-search serve status

If this is a different vault/server, choose an explicit port:

  obsidian-hybrid-search serve --port ${port + 1}`;
}

export function formatMcpInfo(state: McpState, started: boolean): string {
  const status = started ? 'is running' : 'is already running';
  return `Obsidian Hybrid Search MCP server ${status}

URL:  ${state.url}
PID:  ${state.pid}
Logs: ${state.logPath}

Add this to your MCP client:
{
  "mcpServers": {
    "obsidian-hybrid-search": {
      "url": "${state.url}"
    }
  }
}`;
}

export async function fetchHealth(healthUrl: string): Promise<boolean> {
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(500) });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: unknown };
    return body.ok === true;
  } catch {
    return false;
  }
}

export async function waitForHealth(healthUrl: string, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fetchHealth(healthUrl)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

export async function ensureMcpServer(options: EnsureMcpOptions): Promise<EnsureMcpResult> {
  const existing = readMcpState();
  if (existing && isPidAlive(existing.pid) && (await fetchHealth(existing.healthUrl))) {
    return { state: existing, started: false };
  }
  if (existing) removeMcpState();

  if (!(await isPortAvailable(options.host, options.port))) {
    throw new Error(formatPortConflictError(options.port));
  }

  const paths = getMcpPaths();
  mkdirSync(paths.dir, { recursive: true });
  const logFd = openSync(paths.logPath, 'a');
  const cliPath = fileURLToPath(import.meta.url).replace(/mcp-supervisor\.js$/, 'cli.js');
  const urls = buildMcpUrls(options.host, options.port);
  const child = spawnChildWithLogFd(cliPath, options, logFd);
  closeSync(logFd);

  if (child.pid === undefined || child.pid <= 0) {
    throw new Error(`MCP server did not start. Logs: ${paths.logPath}`);
  }

  child.unref();
  const state: McpState = {
    pid: child.pid,
    host: options.host,
    port: options.port,
    url: urls.url,
    healthUrl: urls.healthUrl,
    logPath: paths.logPath,
    vaultPath: config.vaultPath,
    startedAt: new Date().toISOString(),
  };
  writeMcpState(state);

  if (!(await waitForHealth(state.healthUrl, options.healthTimeoutMs)) || !isPidAlive(child.pid)) {
    removeMcpState();
    if (isPidAlive(child.pid)) {
      process.kill(child.pid, 'SIGTERM');
    }
    throw new Error(`MCP server did not become healthy. Logs: ${state.logPath}`);
  }

  return { state, started: true };
}

function spawnChildWithLogFd(cliPath: string, options: EnsureMcpOptions, logFd: number) {
  try {
    return spawn(
      process.execPath,
      [
        cliPath,
        'serve',
        '--http',
        '--foreground',
        '--host',
        options.host,
        '--port',
        String(options.port),
      ],
      {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: { ...process.env, OBSIDIAN_VAULT_PATH: config.vaultPath },
      },
    );
  } catch (err) {
    closeSync(logFd);
    throw err;
  }
}

export async function getMcpStatus(): Promise<McpState | null> {
  const state = readMcpState();
  if (!state) return null;

  if (isPidAlive(state.pid) && (await fetchHealth(state.healthUrl))) {
    return state;
  }

  removeMcpState();
  return null;
}

export function stopMcpServer(): boolean {
  const state = readMcpState();
  removeMcpState();

  if (!state || !isPidAlive(state.pid)) {
    return false;
  }

  process.kill(state.pid, 'SIGTERM');
  return true;
}
