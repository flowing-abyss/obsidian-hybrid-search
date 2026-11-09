import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

export function readHttpAuthToken(): string | undefined {
  const token = process.env.OBSIDIAN_MCP_AUTH_TOKEN;
  if (token === undefined) return undefined;
  if (token.length < 32 || token.length > 512 || !/^[A-Za-z0-9._~+/-]+={0,2}$/.test(token)) {
    throw new Error(
      'OBSIDIAN_MCP_AUTH_TOKEN must contain 32–512 token characters without whitespace. Generate a random token; do not use a password.',
    );
  }
  return token;
}

export function formatHttpHost(host: string): string {
  return isIP(host) === 6 ? `[${host}]` : host;
}

export function isLoopbackHost(host: string): boolean {
  if (host.toLowerCase() === 'localhost') return true;
  if (isIP(host) === 4) return host.startsWith('127.');
  if (isIP(host) !== 6) return false;
  return new URL(`http://[${host}]`).hostname === '[::1]';
}

export function assertHttpBindingSecurity(
  host: string,
  allowAnyHost: boolean | undefined,
  token: string | undefined,
): void {
  if (!token && (!isLoopbackHost(host) || allowAnyHost === true)) {
    throw new Error(
      'Set OBSIDIAN_MCP_AUTH_TOKEN before binding beyond loopback or using --allow-any-host. Use TLS or an encrypted tunnel for remote clients.',
    );
  }
}

export function createBearerValidator(
  token: string | undefined,
): (header: string | undefined) => boolean {
  if (token === undefined) return () => true;
  const expected = createHash('sha256').update(token).digest();
  return (header) => {
    if (!header || !/^Bearer /i.test(header)) return false;
    // Fixed-size digests let timingSafeEqual handle incorrect token lengths too.
    const received = createHash('sha256').update(header.slice(7)).digest();
    return timingSafeEqual(expected, received);
  };
}

export function normalizeHttpAuthority(authority: string): string | null {
  if (!authority || /[\s/@\\?#]/.test(authority)) return null;
  try {
    const parsed = new URL(`http://${authority}`);
    const explicitPort = /:(\d+)$/.exec(authority)?.[1];
    return parsed.hostname + (explicitPort === undefined ? '' : `:${Number(explicitPort)}`);
  } catch {
    return null;
  }
}

export function isSameOrigin(origin: string | undefined, authority: string): boolean {
  if (origin === undefined) return true;
  try {
    const parsed = new URL(origin);
    // Do not trust forwarded headers: the caller must preserve the external
    // Host at a TLS terminator, and an Origin is a serialized origin, not a URL.
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.origin === origin &&
      normalizeHttpAuthority(authority) !== null &&
      parsed.host === new URL(`${parsed.protocol}//${authority}`).host
    );
  } catch {
    return false;
  }
}
