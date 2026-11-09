import assert from 'node:assert/strict';
import { afterEach, describe, it, vi } from 'vitest';
import {
  assertHttpBindingSecurity,
  createBearerValidator,
  formatHttpHost,
  isLoopbackHost,
  isSameOrigin,
  normalizeHttpAuthority,
  readHttpAuthToken,
} from '../src/transports/mcp-http-security.js';

afterEach(() => vi.unstubAllEnvs());

describe('HTTP security policy', () => {
  it('fails closed for empty, short, or invalid configured tokens', () => {
    vi.stubEnv('OBSIDIAN_MCP_AUTH_TOKEN', undefined);
    assert.equal(readHttpAuthToken(), undefined);
    for (const value of [
      '',
      'password',
      'x'.repeat(513),
      `${'x'.repeat(32)}\n`,
      `${'x'.repeat(32)} secret`,
    ]) {
      vi.stubEnv('OBSIDIAN_MCP_AUTH_TOKEN', value);
      assert.throws(readHttpAuthToken, /OBSIDIAN_MCP_AUTH_TOKEN/);
    }
    vi.stubEnv('OBSIDIAN_MCP_AUTH_TOKEN', 'test-only-token-0123456789abcdef0123456789');
    assert.equal(readHttpAuthToken(), process.env.OBSIDIAN_MCP_AUTH_TOKEN);
  });

  it('compares the complete bearer credential and accepts scheme case-insensitively', () => {
    const token = 'test-only-token-0123456789abcdef0123456789';
    const validate = createBearerValidator(token);
    assert.equal(validate(`Bearer ${token}`), true);
    assert.equal(validate(`bearer ${token}`), true);
    for (const header of [
      undefined,
      'Bearer ',
      `Bearer ${token}x`,
      `Bearer ${token.slice(1)}`,
      `Basic ${token}`,
    ]) {
      assert.equal(validate(header), false);
    }
    assert.equal(createBearerValidator(undefined)(undefined), true);
  });

  it('recognizes IPv4 and IPv6 loopback addresses without accepting lookalike hostnames', () => {
    for (const host of [
      '127.0.0.1',
      '127.0.0.2',
      'localhost',
      'LOCALHOST',
      '::1',
      '0:0:0:0:0:0:0:1',
    ]) {
      assert.equal(isLoopbackHost(host), true, host);
      assert.doesNotThrow(() => assertHttpBindingSecurity(host, false, undefined));
    }
    for (const host of ['0.0.0.0', '::', '192.0.2.1', '127.0.0.1.example', 'localhost.example']) {
      assert.equal(isLoopbackHost(host), false, host);
      assert.throws(
        () => assertHttpBindingSecurity(host, false, undefined),
        /OBSIDIAN_MCP_AUTH_TOKEN/,
      );
      assert.doesNotThrow(() => assertHttpBindingSecurity(host, false, 'configured'));
    }
  });

  it('canonicalizes authority case and IPv6 while rejecting URL components in Host', () => {
    assert.equal(formatHttpHost('::1'), '[::1]');
    assert.equal(formatHttpHost('127.0.0.1'), '127.0.0.1');
    assert.equal(normalizeHttpAuthority('LOCALHOST:3939'), 'localhost:3939');
    assert.equal(normalizeHttpAuthority('[0:0:0:0:0:0:0:1]:3939'), '[::1]:3939');
    for (const host of [
      'user@localhost:3939',
      'localhost:3939/path',
      'localhost:3939?query',
      'localhost:3939#fragment',
      'localhost:99999',
      'localhost:3939\\path',
      ' localhost:3939',
    ]) {
      assert.equal(normalizeHttpAuthority(host), null, host);
    }
  });

  it('accepts only serialized HTTP(S) origins with matching authority', () => {
    assert.equal(isSameOrigin(undefined, 'localhost:3939'), true);
    assert.equal(isSameOrigin('http://localhost:3939', 'localhost:3939'), true);
    assert.equal(isSameOrigin('https://localhost:3939', 'localhost:3939'), true);
    assert.equal(isSameOrigin('https://localhost', 'localhost:80'), false);
    assert.equal(isSameOrigin('http://localhost', 'localhost:443'), false);
    assert.equal(isSameOrigin('https://localhost', 'localhost:443'), true);
    for (const origin of [
      'null',
      'file://localhost:3939',
      'http://user@localhost:3939',
      'http://localhost:3939/?x',
      'http://localhost:3939#x',
      'http://localhost:3940',
      'http://localhost:3939 https://attacker.example',
    ]) {
      assert.equal(isSameOrigin(origin, 'localhost:3939'), false, origin);
    }
  });
});
