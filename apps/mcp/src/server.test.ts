import { randomUUID } from 'node:crypto';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { EngagementId, TenantId, UserId } from '@fde/core';
import { describe, expect, it, vi } from 'vitest';

import type { ToolCallContext } from './context.js';
import type { McpToolDeps } from './deps.js';
import { createMcpServer } from './server.js';

const tenantId = randomUUID() as TenantId;
const userId = randomUUID() as UserId;
const engagementId = randomUUID() as EngagementId;
const ctx: ToolCallContext = { tenantId, userId, engagementId };

/** Records every `runInContext` call and just invokes `fn()` — no real Postgres. */
function fakeDeps(over: Partial<McpToolDeps> = {}) {
  const contexts: ToolCallContext[] = [];
  const retrieval = {
    searchContext: vi.fn(async (_q: string) => [
      { sourceId: 's1', permalink: null, factSummaries: [], quotes: [], citations: [] },
    ]),
    listFacts: vi.fn(async () => ({ rows: [] })),
  };
  const lineage = {
    getFactProvenance: vi.fn(async () => ({ fact: { id: 'f1' } }) as never),
    getEntityProvenance: vi.fn(async () => ({ entity: { id: 'e1' } }) as never),
    getGraph: vi.fn(async () => ({ nodes: [], edges: [], truncated: false })),
  };
  const deps: McpToolDeps = {
    retrieval,
    lineage,
    runInContext: async (c, fn) => {
      contexts.push(c);
      return fn();
    },
    ...over,
  };
  return { deps, retrieval, lineage, contexts };
}

async function connectedClient(deps: McpToolDeps) {
  const server = createMcpServer(deps, ctx);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('createMcpServer — tool surface', () => {
  it('registers exactly the five v1 tools', async () => {
    const { deps } = fakeDeps();
    const client = await connectedClient(deps);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'get_entity_provenance',
        'get_fact_provenance',
        'get_graph',
        'list_facts',
        'search_context',
      ].sort(),
    );
  });

  it('none of the tool input schemas expose tenantId/userId/engagementId to the model', async () => {
    const { deps } = fakeDeps();
    const client = await connectedClient(deps);
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const props = Object.keys(tool.inputSchema.properties ?? {});
      expect(props).not.toContain('tenantId');
      expect(props).not.toContain('userId');
      expect(props).not.toContain('engagementId');
    }
  });
});

describe('createMcpServer — search_context', () => {
  it('runs the call through runInContext with the server-bound ctx, forwards the query, returns JSON', async () => {
    const { deps, retrieval, contexts } = fakeDeps();
    const client = await connectedClient(deps);

    const result = await client.callTool({
      name: 'search_context',
      arguments: { query: 'what db?' },
    });

    expect(retrieval.searchContext).toHaveBeenCalledWith('what db?');
    expect(contexts).toEqual([ctx]);
    expect(result.isError).toBeFalsy();
    const content = result.content as { type: string; text: string }[];
    expect(JSON.parse(content[0]!.text)).toEqual([
      { sourceId: 's1', permalink: null, factSummaries: [], quotes: [], citations: [] },
    ]);
  });

  it('a model-supplied engagementId in the call arguments is ignored — ctx stays server-bound', async () => {
    const { deps, contexts } = fakeDeps();
    const client = await connectedClient(deps);

    await client.callTool({
      name: 'search_context',
      // @ts-expect-error — deliberately probing an argument the schema doesn't declare
      arguments: { query: 'x', engagementId: randomUUID(), tenantId: randomUUID() },
    });

    expect(contexts).toEqual([ctx]);
  });

  it('a thrown error (e.g. an authz denial from the wrapped service) surfaces as isError with just the message', async () => {
    const { deps } = fakeDeps();
    deps.retrieval.searchContext = vi.fn(async () => {
      throw new Error('not authorized to view this engagement');
    });
    const client = await connectedClient(deps);

    const result = await client.callTool({ name: 'search_context', arguments: { query: 'x' } });

    expect(result.isError).toBe(true);
    const content = result.content as { type: string; text: string }[];
    expect(content[0]!.text).toBe('not authorized to view this engagement');
  });

  it('rejects an empty query before it ever reaches runInContext (schema validation)', async () => {
    const { deps, contexts } = fakeDeps();
    const client = await connectedClient(deps);

    const result = await client.callTool({ name: 'search_context', arguments: { query: '' } });
    expect(result.isError).toBe(true);
    expect(contexts).toEqual([]);
  });
});

describe('createMcpServer — list_facts / get_fact_provenance / get_entity_provenance / get_graph', () => {
  it('list_facts forwards limit/cursor', async () => {
    const { deps, retrieval } = fakeDeps();
    const client = await connectedClient(deps);
    await client.callTool({ name: 'list_facts', arguments: { limit: 10, cursor: 'c1' } });
    expect(retrieval.listFacts).toHaveBeenCalledWith({ limit: 10, cursor: 'c1' });
  });

  it('get_fact_provenance forwards factId', async () => {
    const { deps, lineage } = fakeDeps();
    const client = await connectedClient(deps);
    await client.callTool({ name: 'get_fact_provenance', arguments: { factId: 'f1' } });
    expect(lineage.getFactProvenance).toHaveBeenCalledWith('f1');
  });

  it('get_entity_provenance forwards entityId', async () => {
    const { deps, lineage } = fakeDeps();
    const client = await connectedClient(deps);
    await client.callTool({ name: 'get_entity_provenance', arguments: { entityId: 'e1' } });
    expect(lineage.getEntityProvenance).toHaveBeenCalledWith('e1');
  });

  it('get_graph forwards entityType/predicate and rejects an invalid enum value', async () => {
    const { deps, lineage } = fakeDeps();
    const client = await connectedClient(deps);
    await client.callTool({ name: 'get_graph', arguments: { entityType: 'person' } });
    expect(lineage.getGraph).toHaveBeenCalledWith({ entityType: 'person', predicate: undefined });

    const result = await client.callTool({
      name: 'get_graph',
      arguments: { entityType: 'not-a-real-type' },
    });
    expect(result.isError).toBe(true);
  });
});
