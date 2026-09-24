import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConnectorCard } from './components/admin/connector-card';
import { DangerZone, shredConfirmed } from './components/admin/danger-zone';
import { EntityProvenanceView } from './components/admin/entity-provenance-panel';
import { KeyManagementPanel } from './components/admin/key-management-panel';
import { PipelineView } from './components/admin/pipeline-view';
import { ProvenanceChain } from './components/admin/provenance-chain';
import { saveConnector, submitByokKey, triggerSync } from './lib/admin-client';
import { buildFlowGraph, graphFacets } from './lib/graph-layout';
import { relativeTime } from './lib/relative-time';
import type {
  ConnectorConfig,
  EngagementGraph,
  EntityProvenance,
  FactProvenance,
  PipelineStatus,
} from './lib/types';

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

describe('shredConfirmed', () => {
  it('requires the typed name to match exactly and a non-empty reason', () => {
    expect(shredConfirmed('Acme', 'Acme', 'offboarded')).toBe(true);
    expect(shredConfirmed('Acme', 'acme', 'offboarded')).toBe(false);
    expect(shredConfirmed('Acme', 'Acme', '')).toBe(false);
    expect(shredConfirmed('Acme', 'Acme', '   ')).toBe(false);
    expect(shredConfirmed('Acme', '', 'offboarded')).toBe(false);
  });
});

describe('DangerZone', () => {
  it('renders the shred control disabled until the confirmation gate is satisfied — cannot fire the request without typing the engagement name', () => {
    const html = renderToStaticMarkup(
      <DangerZone engagementId="eng-1" endCustomerName="Acme" initialStatus="active" />,
    );
    expect(html).toContain('Crypto-shred this engagement');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Crypto-shred this engagement/);
    expect(html).toContain('active');
  });

  it('renders the post-shred state instead of the destructive form once already shredded', () => {
    const html = renderToStaticMarkup(
      <DangerZone engagementId="eng-1" endCustomerName="Acme" initialStatus="shredded" />,
    );
    expect(html).toContain('This engagement has been crypto-shredded.');
    expect(html).not.toContain('Crypto-shred this engagement');
  });
});

describe('KeyManagementPanel', () => {
  it('renders the platform-managed state with a "set" call to action', () => {
    const html = renderToStaticMarkup(
      <KeyManagementPanel engagementId="eng-1" initialByokKeyArn={null} />,
    );
    expect(html).toContain('platform-managed tenant key');
    expect(html).toContain('Set customer-managed key');
    expect(html).not.toContain('customer-managed (BYOK)');
  });

  it('renders the BYOK state, showing the key ARN as an identifier and offering rotation', () => {
    const html = renderToStaticMarkup(
      <KeyManagementPanel
        engagementId="eng-1"
        initialByokKeyArn="arn:aws:kms:us-east-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab"
      />,
    );
    expect(html).toContain('customer-managed (BYOK)');
    expect(html).toContain(
      'arn:aws:kms:us-east-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab',
    );
    expect(html).toContain('Rotate key');
    expect(html).not.toContain('platform-managed tenant key');
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

  it('submitByokKey POSTs the ARN to the same-origin proxy', async () => {
    const fetchMock = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ ok: true, byokKeyArn: 'arn:test' }),
        }) as Response,
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await submitByokKey('eng-1', 'arn:test');
    expect(res).toEqual({ ok: true, byokKeyArn: 'arn:test' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/admin/byok-key');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      engagementId: 'eng-1',
      byokKeyArn: 'arn:test',
    });
  });

  it('submitByokKey surfaces the proxy error message — the "verification failed" case', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: false,
            status: 400,
            json: async () => ({ error: 'the cross-account KMS grant has not propagated yet' }),
          }) as Response,
      ),
    );
    await expect(submitByokKey('eng-1', 'arn:test')).rejects.toThrow(
      'the cross-account KMS grant has not propagated yet',
    );
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
          workspaceRef: 'ws-1',
          containerRef: 'meeting-42',
          authorRef: 'jane@example.com',
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

  it('renders the fact, the evidence quote + source + ACL summary and the run footer under labeled sections', () => {
    const html = renderToStaticMarkup(
      <ProvenanceChain engagementId="eng-1" provenance={provenance} />,
    );
    expect(html).toContain('What was extracted');
    expect(html).toContain('Evidence');
    expect(html).toContain('How this was extracted');
    expect(html).toContain('Standardize on Postgres');
    expect(html).toContain('we will standardize on Postgres');
    expect(html).toContain('chars 10');
    expect(html).toContain('granola');
    expect(html).toContain('meeting-42');
    expect(html).toContain('jane@example.com');
    expect(html).toContain('href="https://ex.com/t/1"');
    expect(html).toContain('Visible to members of that slack channel.');
    expect(html).toContain('2 rules');
    expect(html).toContain('slack_channel');
    expect(html).toContain('claude-sonnet-5');
    expect(html).toContain('extract-v3');
  });

  it('marks a verbatim quote as quoted directly and a condensed one as an extraction summary', () => {
    const verbatimHtml = renderToStaticMarkup(
      <ProvenanceChain engagementId="eng-1" provenance={provenance} />,
    );
    expect(verbatimHtml).toContain('quoted directly from the source');

    const condensed: FactProvenance = {
      ...provenance,
      evidence: [{ ...provenance.evidence[0], quote: 'the team discussed database options' }],
    };
    const condensedHtml = renderToStaticMarkup(
      <ProvenanceChain engagementId="eng-1" provenance={condensed} />,
    );
    expect(condensedHtml).toContain('the extraction condensed this');
  });

  it('renders a plain-language sentence for a missing or empty ACL', () => {
    const noAcl: FactProvenance = {
      ...provenance,
      evidence: [{ ...provenance.evidence[0], acl: null }],
    };
    expect(
      renderToStaticMarkup(<ProvenanceChain engagementId="eng-1" provenance={noAcl} />),
    ).toContain('Who could see this wasn');

    const emptyAcl: FactProvenance = {
      ...provenance,
      evidence: [
        {
          ...provenance.evidence[0],
          acl: { ruleCount: 0, principalKinds: [], capturedAt: null, ttlSeconds: null },
        },
      ],
    };
    expect(
      renderToStaticMarkup(<ProvenanceChain engagementId="eng-1" provenance={emptyAcl} />),
    ).toContain('No extra access rule beyond the engagement');
  });
});

describe('EntityProvenanceView', () => {
  const derivedFact: FactProvenance['fact'] = {
    id: 'f1',
    type: 'decision',
    summary: 'Standardize on Postgres',
    body: null,
    status: 'open',
    confidence: null,
    occurredAt: null,
    createdAt: '2026-09-01T00:00:00Z',
  };
  const source: EntityProvenance['derivedFrom'][number]['source'] = {
    id: 's1',
    connector: 'granola',
    externalId: 'ext-1',
    kind: 'transcript',
    urlPermalink: null,
    workspaceRef: null,
    containerRef: null,
    authorRef: null,
    occurredAt: '2026-09-01T00:00:00Z',
  };

  it('renders a loading state', () => {
    const html = renderToStaticMarkup(
      <EntityProvenanceView engagementId="eng-1" entityLabel="Ada" state={{ status: 'loading' }} />,
    );
    expect(html).toContain('Derived from');
    expect(html).toContain('Loading derivation');
  });

  it('renders an error state', () => {
    const html = renderToStaticMarkup(
      <EntityProvenanceView engagementId="eng-1" entityLabel="Ada" state={{ status: 'error' }} />,
    );
    expect(html).toContain('Could not load how this entity was derived');
  });

  it('renders the empty-derivation state', () => {
    const html = renderToStaticMarkup(
      <EntityProvenanceView
        engagementId="eng-1"
        entityLabel="Ada"
        state={{
          status: 'ready',
          data: {
            entity: { id: 'e1', type: 'person', displayName: 'Ada' },
            derivedFrom: [],
            facts: [],
          },
        }}
      />,
    );
    expect(html).toContain('No single-source derivation recorded.');
  });

  it('reads outgoing derivations as "entity predicate counterpart"', () => {
    const html = renderToStaticMarkup(
      <EntityProvenanceView
        engagementId="eng-1"
        entityLabel="Ada"
        state={{
          status: 'ready',
          data: {
            entity: { id: 'e1', type: 'person', displayName: 'Ada' },
            derivedFrom: [
              {
                relationshipId: 'r1',
                predicate: 'decided_by',
                direction: 'outgoing',
                counterpart: { kind: 'fact', id: 'f1' },
                source,
              },
            ],
            facts: [derivedFact],
          },
        }}
      />,
    );
    const adaIndex = html.indexOf('Ada');
    const factLinkIndex = html.indexOf('decision: Standardize on Postgres');
    expect(adaIndex).toBeGreaterThanOrEqual(0);
    expect(factLinkIndex).toBeGreaterThan(adaIndex);
    expect(html).toContain('decided by');
    expect(html).toContain('decided_by');
  });

  it('reads incoming derivations as "counterpart predicate entity"', () => {
    const html = renderToStaticMarkup(
      <EntityProvenanceView
        engagementId="eng-1"
        entityLabel="Ada"
        state={{
          status: 'ready',
          data: {
            entity: { id: 'e1', type: 'person', displayName: 'Ada' },
            derivedFrom: [
              {
                relationshipId: 'r2',
                predicate: 'decided_by',
                direction: 'incoming',
                counterpart: { kind: 'fact', id: 'f1' },
                source,
              },
            ],
            facts: [derivedFact],
          },
        }}
      />,
    );
    const factLinkIndex = html.indexOf('decision: Standardize on Postgres');
    const adaIndex = html.indexOf('Ada', factLinkIndex);
    expect(factLinkIndex).toBeGreaterThanOrEqual(0);
    expect(adaIndex).toBeGreaterThan(factLinkIndex);
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
