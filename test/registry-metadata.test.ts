import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

interface PackageJson {
  mcpName?: string;
  version: string;
}

interface ServerJson {
  name: string;
  version: string;
  packages: Array<{
    registryType: string;
    identifier: string;
    version?: string;
    transport: { type: string };
    packageArguments?: Array<{ type: string; value?: string }>;
    environmentVariables?: Array<{ name: string; isRequired?: boolean }>;
  }>;
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(path.join(ROOT, relativePath), 'utf-8')) as T;
}

describe('MCP Registry metadata', () => {
  it('links package ownership metadata to server.json', () => {
    const pkg = readJson<PackageJson>('package.json');
    const server = readJson<ServerJson>('server.json');
    const npmPackage = server.packages[0];

    assert.equal(pkg.mcpName, server.name);
    assert.equal(server.version, pkg.version);
    assert.equal(npmPackage?.registryType, 'npm');
    assert.equal(npmPackage.identifier, 'obsidian-hybrid-search');
    assert.equal(npmPackage.version, pkg.version);
    assert.equal(npmPackage.transport.type, 'stdio');
  });

  it('runs the MCP server through the main npm package bin', () => {
    const server = readJson<ServerJson>('server.json');
    const npmPackage = server.packages[0];

    assert.deepEqual(npmPackage?.packageArguments, [{ type: 'positional', value: 'mcp' }]);
  });

  it('requires only the vault path for first-time configuration', () => {
    const server = readJson<ServerJson>('server.json');
    const env = server.packages[0]?.environmentVariables ?? [];

    assert.equal(env.find((entry) => entry.name === 'OBSIDIAN_VAULT_PATH')?.isRequired, true);
    assert.equal(env.filter((entry) => entry.isRequired).length, 1);
  });
});
