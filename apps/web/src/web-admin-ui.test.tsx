import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConnectorCard } from './components/admin/connector-card';
import { PipelineView } from './components/admin/pipeline-view';
import { ProvenanceChain } from './components/admin/provenance-chain';
import { saveConnector, triggerSync } from './lib/admin-client';
import { buildFlowGraph, graphFacets } from './lib/graph-layout';
import { relativeTime } from './lib/relative-time';
import type { ConnectorConfig, EngagementGraph, FactProvenance, PipelineStatus } from './lib/types';

const connector: ConnectorConfig = {
  connector: 'granola',
  authKind: 'bearer',
  enabled: true,
  effectiveRetention: 'full-retention',
  hasCredential: true,
  sync: { status: 'idle', lastRunAt: '2026-09-09T00:00:00Z', cursorPresent: true },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('ConnectorCard', () => {
  it('renders name, auth kind, the "set" credential hint and a sync badge', () => {
    const html = renderToStaticMarkup(<ConnectorCard engagementId="eng-1" connector={connector} />);
    expect(html).toContain('granola');
    expect(html).toContain('bearer');
    expect(html).toContain('•••• set');
    expect(html).toContain('cursor set');
    expect(html).not.toContain('secret-value');
  });
});

describe('admin-client actions', () => {
  it('saveConnector PUTs the patch to the same-origin proxy', async () => {
    const fetchMock = vi.fn(
      async () => ({ ok: true, status: 200, json: async () => connector }) as Response,
    );
    vi.stubGlobal('fetch', fetchMock);

    await saveConnector('eng-1', 'granola', { enabled: false });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/admin/connectors');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({
      engagementId: 'eng-1',
      connectorId: 'granola',
      enabled: false,
    });
  });

  it('triggerSync surfaces the proxy error message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({ ok: false, status: 409, json: async () => ({ error: 'not enabled' }) }) as Response,
      ),
    );
    await expect(triggerSync('eng-1', 'granola', 'backfill')).rejects.toThrow('not enabled');
  });
});

describe('ProvenanceChain', () => {
  const provenance: FactProvenance = {
    fact: {
      id: 'f1',
      type: 'decision',
      summary: 'Standardize on Postgres',
      body: 'Chosen over DynamoDB.',
      status: 'open',
      confidence: 0.9,
      occurredAt: null,
      createdAt: '2026-09-01T00:00:00Z',
    },
    evidence: [
      {
        quote: 'we will standardize on Postgres',
        charStart: 10,
        charEnd: 40,
        relation: 'supports',
        source: {
          id: 's1',
          connector: 'granola',
          externalId: 'ext-1',
          kind: 'transcript',
          urlPermalink: 'https://ex.com/t/1',
          occurredAt: '2026-09-01T00:00:00Z',
        },
        acl: {
          ruleCount: 2,
          principalKinds: ['slack_channel'],
          capturedAt: null,
          ttlSeconds: 3600,
        },
      },
    ],
    extractionRun: {
      model: 'claude-sonnet-5',
      promptVersion: 'extract-v3',
      costUsd: 0.0123,
      createdAt: '2026-09-01T01:00:00Z',
    },
  };

  it('renders the fact, the evidence quote + source + ACL chip and the run footer', () => {
    const html = renderToStaticMarkup(
      <ProvenanceChain engagementId="eng-1" provenance={provenance} />,
    );
    expect(html).toContain('Standardize on Postgres');
    expect(html).toContain('we will standardize on Postgres');
    expect(html).toContain('chars 10');
    expect(html).toContain('granola');
    expect(html).toContain('href="https://ex.com/t/1"');
    expect(html).toContain('2 rules');
    expect(html).toContain('slack_channel');
    expect(html).toContain('claude-sonnet-5');
    expect(html).toContain('extract-v3');
  });
});

describe('graph-layout', () => {
  const graph: EngagementGraph = {
    nodes: [
      { id: 'e1', kind: 'entity', type: 'person', label: 'Ada' },
      { id: 'e2', kind: 'entity', type: 'org', label: 'Acme' },
      { id: 'f1', kind: 'fact', type: 'decision', label: 'Pick Postgres' },
    ],
    edges: [
      {
        id: 'r1',
        fromKind: 'entity',
        fromId: 'e1',
        predicate: 'works_at',
        toKind: 'entity',
        toId: 'e2',
        sourceId: null,
      },
      {
        id: 'r2',
        fromKind: 'fact',
        fromId: 'f1',
        predicate: 'decided_by',
        toKind: 'entity',
        toId: 'e1',
        sourceId: 's1',
      },
      {
        id: 'r3',
        fromKind: 'entity',
        fromId: 'e1',
        predicate: 'works_at',
        toKind: 'entity',
        toId: 'missing',
        sourceId: null,
      },
    ],
    truncated: false,
  };

  it('lays out every node and drops edges to unknown nodes', () => {
    const { nodes, edges } = buildFlowGraph(graph);
    expect(nodes).toHaveLength(3);
    expect(edges).toHaveLength(2);
    expect(nodes.every((n) => Number.isFinite(n.position.x) && Number.isFinite(n.position.y))).toBe(
      true,
    );
    expect(edges[0]).toMatchObject({ source: 'e1', target: 'e2', label: 'works_at' });
  });

  it('derives distinct entity types and predicates for the filters', () => {
    expect(graphFacets(graph)).toEqual({
      entityTypes: ['org', 'person'],
      predicates: ['decided_by', 'works_at'],
    });
  });
});

describe('PipelineView', () => {
  const pipeline: PipelineStatus = {
    syncStates: [
      {
        connector: 'granola',
        status: 'idle',
        lastRunAt: '2026-09-09T00:00:00Z',
        cursorPresent: true,
        updatedAt: '2026-09-09T00:00:00Z',
      },
    ],
    recentExtractionRuns: [
      {
        model: 'claude-sonnet-5',
        promptVersion: 'extract-v3',
        costUsd: 0.5,
        inputSourceCount: 4,
        createdAt: '2026-09-08T00:00:00Z',
      },
    ],
    rollups: {
      totalFacts: 12,
      totalEmbeddings: 30,
      totalCostUsd: 1.25,
      sourcesByConnector: { granola: 4 },
    },
  };

  it('renders rollup stat values and both tables', () => {
    const html = renderToStaticMarkup(<PipelineView pipeline={pipeline} />);
    expect(html).toContain('>12<');
    expect(html).toContain('$1.2500');
    expect(html).toContain('granola: 4');
    expect(html).toContain('claude-sonnet-5');
    expect(html).toContain('extract-v3');
  });
});

describe('relativeTime', () => {
  it('formats past timestamps and rejects junk', () => {
    const now = Date.parse('2026-09-10T00:00:00Z');
    expect(relativeTime('2026-09-09T00:00:00Z', now)).toBe('yesterday');
    expect(relativeTime(null)).toBeNull();
    expect(relativeTime('not-a-date')).toBeNull();
  });
});
