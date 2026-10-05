import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

// The official registry rejects duplicate versions. Verify the exact existing
// record before skipping it; other HTTP errors or metadata conflicts must fail.
try {
  const server = JSON.parse(readFileSync('server.json', 'utf8'));
  const registry = process.env.MCP_REGISTRY_URL || 'https://registry.modelcontextprotocol.io';
  const endpoint = `${registry}/v0.1/servers/${encodeURIComponent(server.name)}/versions/${encodeURIComponent(server.version)}?include_deleted=true`;
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(30_000) });
  if (response.ok) {
    const record = await response.json();
    if (
      record._meta?.['io.modelcontextprotocol.registry/official']?.status !== 'active' ||
      !isDeepStrictEqual(record.server, server)
    ) {
      throw new Error(
        `MCP Registry already contains a conflicting or inactive record for ${server.name}@${server.version}.`,
      );
    }
    console.log(`${server.name}@${server.version} is already published in MCP Registry.`);
  } else if (response.status === 404) {
    const publisher = process.env.MCP_PUBLISHER_PATH || './mcp-publisher';
    // An explicit interpreter can prepend its script path without relying on a shebang.
    const leadingArgs = JSON.parse(process.env.MCP_PUBLISHER_ARGS || '[]');
    if (
      !Array.isArray(leadingArgs) ||
      leadingArgs.some((argument) => typeof argument !== 'string')
    ) {
      throw new Error('MCP_PUBLISHER_ARGS must be a JSON array of strings.');
    }
    for (const args of [['login', 'github-oidc'], ['publish']]) {
      const result = spawnSync(publisher, [...leadingArgs, ...args], { stdio: 'inherit' });
      if (result.error) throw result.error;
      if (result.status !== 0) process.exit(result.status || 1);
    }
  } else {
    throw new Error(
      `MCP Registry lookup returned status ${response.status}; refusing to ignore this failure.`,
    );
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
