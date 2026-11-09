import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from '@modelcontextprotocol/server';
import assert from 'node:assert/strict';
import { describe, it, vi } from 'vitest';

const searcher = await import('../src/search/searcher.js');
const { closeMcpRuntime, createMcpServer } = await import('../src/transports/mcp-runtime.js');

describe('MCP runtime admission', () => {
  it('bounds actual tool operations across clients, retains slots after disconnect, and recovers', async () => {
    const runtime = {
      version: '1.0.0',
      contextLength: 512,
      modelName: 'test',
      embeddingDim: null,
      getUpdateStatus: () => ({ state: 'up_to_date' as const }),
    };
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let admitted!: () => void;
    const allAdmitted = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    let started = 0;
    const search = vi.spyOn(searcher, 'search').mockImplementation(async () => {
      started += 1;
      if (started === 32) admitted();
      await blocked;
      return [];
    });
    const connections: Array<{ client: Client; server: Server }> = [];
    const pending: Array<Promise<unknown>> = [];
    async function connect(): Promise<Client> {
      const client = new Client({ name: 'admission-test', version: '1' });
      const server = createMcpServer(runtime);
      connections.push({ client, server });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      return client;
    }
    try {
      for (let i = 0; i < 32; i += 1) {
        const client = await connect();
        pending.push(
          client
            .callTool({ name: 'search', arguments: { query: `query ${i}` } })
            .catch(() => undefined),
        );
      }
      await allAdmitted;
      const overflow = await connect();
      const rejected = await overflow.callTool({
        name: 'search',
        arguments: { query: 'overflow' },
      });
      assert.equal(rejected.isError, true);
      assert.match(JSON.stringify(rejected), /busy.*32 concurrent operations/);
      assert.equal(started, 32);

      await connections[0]!.client.close();
      const disconnected = await overflow.callTool({
        name: 'search',
        arguments: { query: 'after disconnect' },
      });
      assert.equal(disconnected.isError, true);
      assert.equal(started, 32, 'a disconnected client must not free unfinished inference work');

      release();
      await Promise.all(pending);
      const recovered = await overflow.callTool({
        name: 'search',
        arguments: { query: 'after completion' },
      });
      assert.notEqual(recovered.isError, true);
      assert.equal(started, 33);
    } finally {
      release();
      await Promise.allSettled(pending);
      await closeMcpRuntime(runtime);
      await Promise.allSettled(
        connections.flatMap(({ client, server }) => [client.close(), server.close()]),
      );
      search.mockRestore();
    }
  });
});
