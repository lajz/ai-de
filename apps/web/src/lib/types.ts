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
  /** customer-supplied KMS key ARN when BYOK/CMEK is in effect; null on the platform-managed tenant key */
  byokKeyArn: string | null;
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

export interface FactPage {
  rows: Fact[];
  /** pass back as `?cursor` to fetch the next page */
  nextCursor?: string;
}

export interface QaCitation {
  sourceId: string;
  permalink: string | null;
  quote: string;
  /** the fact this citation's evidence belongs to — links onward to `/engagements/[id]/lineage?factId=`. */
  factId: string;
}

export interface QaResult {
  answer: string;
  citations: QaCitation[];
}

/**
 * One prior turn of an agentic Q&A conversation, sent back as `history` on
 * the next question — `/qa/agentic` is stateless across requests, so
 * `AskPanel` is what remembers the conversation, not the server.
 */
export interface QaTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** One SSE event from `POST /engagements/:id/qa/agentic` — mirrors `AgenticQaEvent` in `@fde/api`. */
export type AgenticQaEvent =
  | { type: 'tool_step'; tool: string; status: 'started' | 'ok' | 'error' }
  | { type: 'answer'; answer: string; citations: QaCitation[] }
  | { type: 'error'; message: string };

// --- Connector configuration -------------------------------------------------

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

// --- Custom integrations -----------------------------------------------------
// Mirrors `customIntegrationMappingSchema` in `@fde/core` (the web app does not
// depend on it); the API re-validates everything.

export const CUSTOM_ENTITY_TYPES = [
  'person',
  'organization',
  'work_item',
  'document',
  'meeting',
] as const;
export const CUSTOM_PREDICATES = [
  'owns',
  'accountable_for',
  'informed_of',
  'implemented_by',
  'blocks',
  'supersedes',
  'relates_to',
  'member_of',
  'stakeholder_in',
] as const;
export const CUSTOM_SOURCE_KINDS = ['transcript', 'message', 'doc', 'issue', 'comment'] as const;

export interface CustomEntityMapping {
  key: string;
  type: (typeof CUSTOM_ENTITY_TYPES)[number];
  externalIdPath: string;
  displayNamePath: string;
  bodyPath?: string;
  attributes: Record<string, string>;
}

export interface CustomRelationshipMapping {
  from: string;
  predicate: (typeof CUSTOM_PREDICATES)[number];
  to: string;
}

export interface CustomIntegrationMapping {
  artifact: {
    externalIdPath: string;
    kind: (typeof CUSTOM_SOURCE_KINDS)[number];
    occurredAtPath: string;
    urlPermalinkPath?: string;
  };
  entities: CustomEntityMapping[];
  relationships: CustomRelationshipMapping[];
}

export interface CustomIntegration {
  id: string;
  name: string;
  enabled: boolean;
  mapping: CustomIntegrationMapping;
  secretPrefix: string;
  secretSetAt: string;
  lastIngestedAt: string | null;
  createdAt: string;
  updatedAt: string;
  ingestUrl: string;
}

/** Returned once, by create / rotate. */
export interface CustomIntegrationWithSecret extends CustomIntegration {
  secret: string;
}

export interface CustomMappingIssue {
  at: string;
  message: string;
}

export interface CustomMappingTestResult {
  records: unknown[];
  issues: CustomMappingIssue[];
}

export interface UpdateCustomIntegrationBody {
  name?: string;
  enabled?: boolean;
  mapping?: CustomIntegrationMapping;
}

// --- Data lineage ------------------------------------------------------------

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
  /** 0-1 model-judged confidence for an agentically-suggested edge; null for a deterministic one */
  confidence: number | null;
}

export interface EngagementGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
}

// --- Entity provenance --------------------------------------------------------

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
  /** 0-1 model-judged confidence for an agentically-suggested edge; null for a deterministic one */
  confidence: number | null;
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

// --- Danger zone (crypto-shred) -----------------------------------------------

export interface CryptoShredResult {
  ok: boolean;
  /** true if the engagement was already shredded before this call */
  alreadyShredded: boolean;
}

// --- Key management (BYOK/CMEK) -----------------------------------------------

export interface SetByokKeyResult {
  ok: boolean;
  byokKeyArn: string;
}
