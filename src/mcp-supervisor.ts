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
import { normalizeAllowedHosts } from './mcp-http-server.js';

export interface McpState {
  pid: number;
  host: string;
  port: number;
  url: string;
  healthUrl: string;
  logPath: string;
  vaultPath: string;
  allowedHosts?: string[];
  allowAnyHost?: boolean;
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
  allowedHosts?: string[];
  allowAnyHost?: boolean;
  healthTimeoutMs?: number;
}

export interface EnsureMcpResult {
  state: McpState;
  started: boolean;
}

export interface McpHealthInfo {
  ok: true;
  name?: unknown;
  transport?: unknown;
  vaultPath?: unknown;
  version?: unknown;
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

export function matchesRequestedState(
  state: McpState,
  options: EnsureMcpOptions,
  vaultPath: string,
): boolean {
  const stateAllowAnyHost = state.allowAnyHost === true;
  const requestedAllowAnyHost = options.allowAnyHost === true;
  const requestedAllowedHosts = normalizeAllowedHosts(options.allowedHosts);
  const stateAllowedHosts = normalizeAllowedHosts(state.allowedHosts);
  return (
    state.host === options.host &&
    state.port === options.port &&
    state.vaultPath === vaultPath &&
    stateAllowAnyHost === requestedAllowAnyHost &&
    (stateAllowAnyHost || sameStringSet(stateAllowedHosts, requestedAllowedHosts))
  );
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

export function healthMatchesState(state: McpState, healthInfo: McpHealthInfo | null): boolean {
  if (healthInfo === null) return false;
  return (
    healthInfo.ok === true &&
    healthInfo.name === 'obsidian-hybrid-search' &&
    healthInfo.transport === 'streamable-http' &&
    healthInfo.vaultPath === state.vaultPath &&
    state.healthUrl === buildMcpUrls(state.host, state.port).healthUrl
  );
}

function formatMcpStateMismatchError(
  state: McpState,
  options: EnsureMcpOptions,
  vaultPath: string,
): string {
  const requestedUrls = buildMcpUrls(options.host, options.port);
  return `An MCP server is already recorded for a different MCP server.

Current:
  URL:   ${state.url}
  Vault: ${state.vaultPath}

Requested:
  URL:   ${requestedUrls.url}
  Vault: ${vaultPath}

Run "obsidian-hybrid-search serve stop" before starting a different server, or set an explicit XDG_CACHE_HOME for separate state.`;
}

export async function fetchHealthInfo(healthUrl: string): Promise<McpHealthInfo | null> {
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(500) });
    if (!res.ok) return null;
    const body = (await res.json()) as { ok?: unknown };
    if (body.ok !== true) return null;
    return body as McpHealthInfo;
  } catch {
    return null;
  }
}

export async function fetchHealth(healthUrl: string): Promise<boolean> {
  return (await fetchHealthInfo(healthUrl)) !== null;
}

export async function waitForHealth(healthUrl: string, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fetchHealth(healthUrl)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function waitForStateHealth(state: McpState, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (healthMatchesState(state, await fetchHealthInfo(state.healthUrl))) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

export async function ensureMcpServer(options: EnsureMcpOptions): Promise<EnsureMcpResult> {
  const vaultPath = config.vaultPath;
  const allowedHosts = normalizeAllowedHosts(options.allowedHosts);
  const allowAnyHost = options.allowAnyHost === true;
  const existing = readMcpState();
  if (
    existing &&
    isPidAlive(existing.pid) &&
    healthMatchesState(existing, await fetchHealthInfo(existing.healthUrl))
  ) {
    if (matchesRequestedState(existing, options, vaultPath)) {
      return { state: existing, started: false };
    }
    throw new Error(formatMcpStateMismatchError(existing, options, vaultPath));
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
    vaultPath,
    allowedHosts,
    allowAnyHost,
    startedAt: new Date().toISOString(),
  };
  writeMcpState(state);

  if (!(await waitForStateHealth(state, options.healthTimeoutMs)) || !isPidAlive(child.pid)) {
    removeMcpState();
    if (isPidAlive(child.pid)) {
      process.kill(child.pid, 'SIGTERM');
    }
    throw new Error(`MCP server did not become healthy. Logs: ${state.logPath}`);
  }

  return { state, started: true };
}

export function buildMcpServeArgs(options: EnsureMcpOptions): string[] {
  const args = [
    'serve',
    '--http',
    '--foreground',
    '--host',
    options.host,
    '--port',
    String(options.port),
  ];
  for (const host of normalizeAllowedHosts(options.allowedHosts)) {
    args.push('--allowed-host', host);
  }
  if (options.allowAnyHost === true) {
    args.push('--allow-any-host');
  }
  return args;
}

function spawnChildWithLogFd(cliPath: string, options: EnsureMcpOptions, logFd: number) {
  try {
    return spawn(process.execPath, [cliPath, ...buildMcpServeArgs(options)], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, OBSIDIAN_VAULT_PATH: config.vaultPath },
    });
  } catch (err) {
    closeSync(logFd);
    throw err;
  }
}

export async function getMcpStatus(): Promise<McpState | null> {
  const state = readMcpState();
  if (!state) return null;

  if (isPidAlive(state.pid) && healthMatchesState(state, await fetchHealthInfo(state.healthUrl))) {
    return state;
  }

  removeMcpState();
  return null;
}

export async function stopMcpServer(): Promise<boolean> {
  const state = readMcpState();

  if (!state || !isPidAlive(state.pid)) {
    if (state) removeMcpState();
    return false;
  }

  if (!healthMatchesState(state, await fetchHealthInfo(state.healthUrl))) {
    removeMcpState();
    return false;
  }

  removeMcpState();
  process.kill(state.pid, 'SIGTERM');
  return true;
}
