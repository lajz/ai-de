/**
 * Response shapes served by `@fde/api` (see `apps/api/openapi.json`). Hand-kept
 * to the handful of fields this read-only view renders — a generated client is a
 * later refinement.
 */
export interface Engagement {
  id: string;
  endCustomerName: string;
  regionPin: string;
  retentionPolicy: string;
  status: string;
  createdAt: string;
}

export interface EvidenceCitation {
  sourceId: string;
  permalink: string | null;
  quote: string | null;
  charStart: number | null;
  charEnd: number | null;
  relation: string;
}

export interface Fact {
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

export interface QaCitation {
  sourceId: string;
  permalink: string | null;
  quote: string;
}

export interface QaResult {
  answer: string;
  citations: QaCitation[];
}

// --- /admin: connector configuration -----------------------------------------

export type RetentionPolicy = 'reference-only' | 'derived-ephemeral-raw' | 'full-retention';

export interface ConnectorSync {
  status: 'idle' | 'running' | 'error' | null;
  lastRunAt: string | null;
  cursorPresent: boolean;
}

export interface ConnectorConfig {
  connector: string;
  authKind: 'nango-oauth' | 'bearer' | 'mcp-oauth' | 'inbound-push';
  enabled: boolean;
  effectiveRetention: RetentionPolicy;
  hasCredential: boolean;
  sync: ConnectorSync;
}

export interface PutConnectorBody {
  enabled?: boolean;
  retentionOverride?: RetentionPolicy | null;
  credential?: string;
}

export type SyncMode = 'backfill' | 'incremental';

// --- /admin: data lineage --------------------------------------------------

export interface AclSummary {
  ruleCount: number;
  principalKinds: string[];
  capturedAt: string | null;
  ttlSeconds: number | null;
}

export interface ProvenanceSource {
  id: string;
  connector: string;
  externalId: string;
  kind: string;
  urlPermalink: string | null;
  workspaceRef: string | null;
  containerRef: string | null;
  authorRef: string | null;
  occurredAt: string;
}

export interface ProvenanceEvidence {
  quote: string | null;
  charStart: number | null;
  charEnd: number | null;
  relation: 'supports' | 'contradicts';
  source: ProvenanceSource;
  acl: AclSummary | null;
}

export interface ProvenanceFact {
  id: string;
  type: string;
  summary: string;
  body: string | null;
  status: string;
  confidence: number | null;
  occurredAt: string | null;
  createdAt: string;
}

export interface ExtractionRun {
  model: string;
  promptVersion: string;
  costUsd: number | null;
  createdAt: string;
}

export interface FactProvenance {
  fact: ProvenanceFact;
  evidence: ProvenanceEvidence[];
  extractionRun: ExtractionRun | null;
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
  fromKind: 'entity' | 'fact';
  fromId: string;
  predicate: string;
  toKind: 'entity' | 'fact';
  toId: string;
  sourceId: string | null;
}

export interface EngagementGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
}

// --- /admin: entity provenance -----------------------------------------------

export interface EntityDerivationCounterpart {
  kind: 'entity' | 'fact';
  id: string;
}

export interface EntityDerivation {
  relationshipId: string;
  predicate: string;
  direction: 'outgoing' | 'incoming';
  counterpart: EntityDerivationCounterpart;
  source: ProvenanceSource;
}

export interface EntityProvenanceFact {
  id: string;
  type: string;
  summary: string;
}

export interface EntityProvenance {
  entity: { id: string; type: string; displayName: string };
  derivedFrom: EntityDerivation[];
  facts: EntityProvenanceFact[];
}

export interface SyncState {
  connector: string;
  status: string;
  lastRunAt: string | null;
  cursorPresent: boolean;
  updatedAt: string;
}

export interface PipelineRun {
  model: string;
  promptVersion: string;
  costUsd: number | null;
  inputSourceCount: number;
  createdAt: string;
}

export interface PipelineRollups {
  totalFacts: number;
  totalEmbeddings: number;
  totalCostUsd: number;
  sourcesByConnector: Record<string, number>;
}

export interface PipelineStatus {
  syncStates: SyncState[];
  recentExtractionRuns: PipelineRun[];
  rollups: PipelineRollups;
}
