import type { ToolCallContext } from './context.js';

/**
 * The tool surface this package wraps, expressed as the minimal shape each
 * `apps/api` service already satisfies (`RetrievalService`, `LineageService`)
 * — a structural contract, not an import of `apps/api` itself. Keeping the
 * dependency direction this way is what lets the *same* `apps/mcp` server be
 * handed a different `McpRetrieval`/`McpLineage` implementation later (an
 * external-caller build, a test double) without `apps/mcp` ever depending on
 * a Nest application.
 */
export interface QaCitation {
  sourceId: string;
  permalink: string | null;
  quote: string;
}

export interface ContextSource {
  sourceId: string;
  permalink: string | null;
  factSummaries: string[];
  quotes: string[];
  citations: QaCitation[];
}

export interface ListFactsFilter {
  limit?: number;
  cursor?: string;
}

export interface EvidenceCitation {
  sourceId: string;
  permalink: string | null;
  quote: string | null;
  charStart: number | null;
  charEnd: number | null;
  relation: string;
}

export interface FactRecord {
  id: string;
  type: string;
  summary: string;
  body: string | null;
  status: string;
  confidence: number | null;
  occurredAt: string | null;
  createdAt: string;
  citations: EvidenceCitation[];
}

export interface FactPage {
  rows: FactRecord[];
  nextCursor?: string;
}

export interface ProvenanceEvidence {
  quote: string | null;
  charStart: number | null;
  charEnd: number | null;
  relation: string;
  source: {
    id: string;
    connector: string;
    externalId: string;
    kind: string;
    urlPermalink: string | null;
    workspaceRef: string | null;
    containerRef: string | null;
    authorRef: string | null;
    occurredAt: string;
  };
  acl: {
    ruleCount: number;
    principalKinds: string[];
    capturedAt: string | null;
    ttlSeconds: number | null;
  } | null;
}

export interface FactProvenance {
  fact: {
    id: string;
    type: string;
    summary: string;
    body: string | null;
    status: string;
    confidence: number | null;
    occurredAt: string | null;
    createdAt: string;
  };
  evidence: ProvenanceEvidence[];
  extractionRun: {
    model: string;
    promptVersion: string;
    costUsd: number | null;
    createdAt: string;
  } | null;
}

export interface EntityDerivation {
  relationshipId: string;
  predicate: string;
  direction: 'outgoing' | 'incoming';
  counterpart: { kind: string; id: string };
  source: {
    id: string;
    connector: string;
    externalId: string;
    kind: string;
    urlPermalink: string | null;
    workspaceRef: string | null;
    containerRef: string | null;
    authorRef: string | null;
    occurredAt: string;
  };
  confidence: number | null;
}

export interface EntityProvenance {
  entity: { id: string; type: string; displayName: string };
  derivedFrom: EntityDerivation[];
  facts: { id: string; type: string; summary: string }[];
}

export interface GraphNode {
  id: string;
  kind: 'entity' | 'fact';
  type: string;
  label: string;
  status?: string;
  externalRefs?: unknown[];
}

export interface GraphEdge {
  id: string;
  fromKind: string;
  fromId: string;
  predicate: string;
  toKind: string;
  toId: string;
  sourceId: string | null;
  confidence: number | null;
}

export interface EngagementGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
}

export interface McpRetrieval {
  searchContext(question: string): Promise<ContextSource[]>;
  listFacts(filter: ListFactsFilter): Promise<FactPage>;
}

export interface McpLineage {
  getFactProvenance(factId: string): Promise<FactProvenance>;
  getEntityProvenance(entityId: string): Promise<EntityProvenance>;
  getGraph(filter: { entityType?: string; predicate?: string }): Promise<EngagementGraph>;
}

/**
 * What every tool handler needs: the wrapped services, plus a way to
 * establish a short-lived, tenant/engagement-scoped request context around
 * one call (`runInContext` — see `context.ts`'s `withToolContext` for the
 * real, DB-backed implementation `createDbToolDeps` wires in). Injected as a
 * function, not `db`/`keyProvider` directly, so unit tests can fake it
 * without a real Postgres — real transaction-scoping is integration-tested
 * (`server.integration.test.ts`).
 */
export interface McpToolDeps {
  retrieval: McpRetrieval;
  lineage: McpLineage;
  runInContext: <T>(ctx: ToolCallContext, fn: () => Promise<T>) => Promise<T>;
}
