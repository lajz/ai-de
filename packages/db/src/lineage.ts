import { and, count, desc, eq, inArray, or, sum } from 'drizzle-orm';

import type {
  Ciphertext,
  EngagementId,
  EntityType,
  EvidenceRelation,
  ExternalRef,
  NodeKind,
  Predicate,
  TenantId,
} from '@fde/core';

import type { DbTransaction } from './client.js';
import { embeddings } from './schema/embeddings.js';
import { evidence, extractionRuns, facts } from './schema/facts.js';
import { entities, relationships } from './schema/graph.js';
import { aclSnapshots, sources } from './schema/sources.js';

/**
 * Data-lineage read queries for the `/admin` provenance / graph / pipeline
 * endpoints. Same contract as `retrieval.ts`: every function takes the caller's
 * already-open `withTenant` / `withEngagement` transaction, pins both
 * `tenant_id` and `engagement_id` (RLS + explicit predicate), and never opens
 * its own transaction. 🔒 columns come back as ciphertext; the caller decrypts
 * them *after* its `canViewEngagement` gate, in the request context.
 */

// --- provenance chain ------------------------------------------------------

export interface ProvenanceFactRow {
  id: string;
  type: string;
  summary: string;
  body: Ciphertext | null;
  status: string;
  confidence: number | null;
  occurredAt: Date | null;
  createdAt: Date;
  extractionRunId: string | null;
}

/** The one fact at the head of a provenance chain, or `undefined` if not in the engagement. */
export async function selectFactForProvenance(
  tx: DbTransaction,
  tenantId: TenantId,
  engagementId: EngagementId,
  factId: string,
): Promise<ProvenanceFactRow | undefined> {
  const [row] = await tx
    .select({
      id: facts.id,
      type: facts.type,
      summary: facts.summary,
      body: facts.body,
      status: facts.status,
      confidence: facts.confidence,
      occurredAt: facts.occurredAt,
      createdAt: facts.createdAt,
      extractionRunId: facts.extractionRunId,
    })
    .from(facts)
    .where(
      and(eq(facts.tenantId, tenantId), eq(facts.engagementId, engagementId), eq(facts.id, factId)),
    )
    .limit(1);
  return row;
}

export interface ProvenanceEvidenceRow {
  evidenceId: string;
  quote: Ciphertext | null;
  charStart: number | null;
  charEnd: number | null;
  relation: EvidenceRelation;
  sourceId: string;
  connector: string;
  externalId: string;
  kind: string;
  urlPermalink: string | null;
  workspaceRef: string | null;
  containerRef: string | null;
  authorRef: string | null;
  occurredAt: Date;
  aclPrincipalRules: Ciphertext | null;
  aclCapturedAt: Date | null;
  aclTtlSeconds: number | null;
}

/**
 * Every `evidence` row for a fact, joined to its `source` and (left) the
 * source's `acl_snapshots` row. 🔒 `quote` and 🔒 `principalRules` returned
 * as ciphertext.
 */
export function selectProvenanceEvidence(
  tx: DbTransaction,
  tenantId: TenantId,
  engagementId: EngagementId,
  factId: string,
): Promise<ProvenanceEvidenceRow[]> {
  return tx
    .select({
      evidenceId: evidence.id,
      quote: evidence.quote,
      charStart: evidence.charStart,
      charEnd: evidence.charEnd,
      relation: evidence.relation,
      sourceId: sources.id,
      connector: sources.connector,
      externalId: sources.externalId,
      kind: sources.kind,
      urlPermalink: sources.urlPermalink,
      workspaceRef: sources.workspaceRef,
      containerRef: sources.containerRef,
      authorRef: sources.authorRef,
      occurredAt: sources.occurredAt,
      aclPrincipalRules: aclSnapshots.principalRules,
      aclCapturedAt: aclSnapshots.capturedAt,
      aclTtlSeconds: aclSnapshots.ttlSeconds,
    })
    .from(evidence)
    .innerJoin(
      sources,
      and(eq(sources.engagementId, evidence.engagementId), eq(sources.id, evidence.sourceId)),
    )
    .leftJoin(
      aclSnapshots,
      and(
        eq(aclSnapshots.engagementId, sources.engagementId),
        eq(aclSnapshots.id, sources.aclSnapshotId),
      ),
    )
    .where(
      and(
        eq(evidence.tenantId, tenantId),
        eq(evidence.engagementId, engagementId),
        eq(evidence.factId, factId),
      ),
    );
}

export interface ExtractionRunRow {
  id: string;
  model: string;
  promptVersion: string;
  costUsd: number | null;
  inputSourceIds: string[];
  createdAt: Date;
}

/** One `extraction_runs` row by id (scoped to the engagement), or `undefined`. */
export async function selectExtractionRun(
  tx: DbTransaction,
  tenantId: TenantId,
  engagementId: EngagementId,
  runId: string,
): Promise<ExtractionRunRow | undefined> {
  const [row] = await tx
    .select({
      id: extractionRuns.id,
      model: extractionRuns.model,
      promptVersion: extractionRuns.promptVersion,
      costUsd: extractionRuns.costUsd,
      inputSourceIds: extractionRuns.inputSourceIds,
      createdAt: extractionRuns.createdAt,
    })
    .from(extractionRuns)
    .where(
      and(
        eq(extractionRuns.tenantId, tenantId),
        eq(extractionRuns.engagementId, engagementId),
        eq(extractionRuns.id, runId),
      ),
    )
    .limit(1);
  return row;
}

// --- entity provenance (cleartext only) -----------------------------------

export interface EntityProvenanceRow {
  id: string;
  type: EntityType;
  displayName: string;
}

/** The one entity at the head of an entity-provenance panel, or `undefined` if not in the engagement. */
export async function selectEntityForProvenance(
  tx: DbTransaction,
  tenantId: TenantId,
  engagementId: EngagementId,
  entityId: string,
): Promise<EntityProvenanceRow | undefined> {
  const [row] = await tx
    .select({ id: entities.id, type: entities.type, displayName: entities.displayName })
    .from(entities)
    .where(
      and(
        eq(entities.tenantId, tenantId),
        eq(entities.engagementId, engagementId),
        eq(entities.id, entityId),
      ),
    )
    .limit(1);
  return row;
}

export interface EntityProvenanceEdgeRow {
  relationshipId: string;
  predicate: Predicate;
  fromKind: NodeKind;
  fromId: string;
  toKind: NodeKind;
  toId: string;
  sourceId: string;
  connector: string;
  externalId: string;
  kind: string;
  urlPermalink: string | null;
  workspaceRef: string | null;
  containerRef: string | null;
  authorRef: string | null;
  occurredAt: Date;
}

/**
 * Every `relationships` edge touching `entityId` (as either endpoint) that
 * carries a `sourceId` — i.e. was attested by a single artifact — joined to
 * that source. Edges with no `sourceId` (multi-artifact / inferred) are not
 * "derived from" any one source and are excluded. Cleartext only: no
 * decryption, no audit log needed (mirrors `selectGraphEdges`).
 */
export function selectEntityProvenanceEdges(
  tx: DbTransaction,
  tenantId: TenantId,
  engagementId: EngagementId,
  entityId: string,
): Promise<EntityProvenanceEdgeRow[]> {
  return tx
    .select({
      relationshipId: relationships.id,
      predicate: relationships.predicate,
      fromKind: relationships.fromKind,
      fromId: relationships.fromId,
      toKind: relationships.toKind,
      toId: relationships.toId,
      sourceId: sources.id,
      connector: sources.connector,
      externalId: sources.externalId,
      kind: sources.kind,
      urlPermalink: sources.urlPermalink,
      workspaceRef: sources.workspaceRef,
      containerRef: sources.containerRef,
      authorRef: sources.authorRef,
      occurredAt: sources.occurredAt,
    })
    .from(relationships)
    .innerJoin(
      sources,
      and(
        eq(sources.engagementId, relationships.engagementId),
        eq(sources.id, relationships.sourceId),
      ),
    )
    .where(
      and(
        eq(relationships.tenantId, tenantId),
        eq(relationships.engagementId, engagementId),
        or(
          and(eq(relationships.fromKind, 'entity'), eq(relationships.fromId, entityId)),
          and(eq(relationships.toKind, 'entity'), eq(relationships.toId, entityId)),
        ),
      ),
    );
}

export interface EntityProvenanceFactRow {
  id: string;
  type: string;
  summary: string;
}

/** `facts` rows by id, scoped to the engagement — the fact-node counterparts of an entity's edges. */
export function selectFactsByIds(
  tx: DbTransaction,
  tenantId: TenantId,
  engagementId: EngagementId,
  factIds: string[],
): Promise<EntityProvenanceFactRow[]> {
  if (factIds.length === 0) return Promise.resolve([]);
  return tx
    .select({ id: facts.id, type: facts.type, summary: facts.summary })
    .from(facts)
    .where(
      and(
        eq(facts.tenantId, tenantId),
        eq(facts.engagementId, engagementId),
        inArray(facts.id, factIds),
      ),
    );
}

// --- provenance graph (cleartext only) -----------------------------------

export interface GraphEntityRow {
  id: string;
  type: EntityType;
  displayName: string;
  externalRefs: ExternalRef[];
}

export function selectGraphEntities(
  tx: DbTransaction,
  tenantId: TenantId,
  engagementId: EngagementId,
  filter: { entityType?: EntityType } = {},
): Promise<GraphEntityRow[]> {
  const conds = [eq(entities.tenantId, tenantId), eq(entities.engagementId, engagementId)];
  if (filter.entityType) conds.push(eq(entities.type, filter.entityType));
  return tx
    .select({
      id: entities.id,
      type: entities.type,
      displayName: entities.displayName,
      externalRefs: entities.externalRefs,
    })
    .from(entities)
    .where(and(...conds));
}

export interface GraphFactRow {
  id: string;
  type: string;
  summary: string;
  status: string;
}

export function selectGraphFacts(
  tx: DbTransaction,
  tenantId: TenantId,
  engagementId: EngagementId,
): Promise<GraphFactRow[]> {
  return tx
    .select({
      id: facts.id,
      type: facts.type,
      summary: facts.summary,
      status: facts.status,
    })
    .from(facts)
    .where(and(eq(facts.tenantId, tenantId), eq(facts.engagementId, engagementId)));
}

export interface GraphEdgeRow {
  id: string;
  fromKind: string;
  fromId: string;
  predicate: Predicate;
  toKind: string;
  toId: string;
  sourceId: string | null;
}

/**
 * `relationships` edges, capped at `limit`. Call with `limit = cap + 1` and
 * treat an over-cap result as truncated.
 */
export function selectGraphEdges(
  tx: DbTransaction,
  tenantId: TenantId,
  engagementId: EngagementId,
  filter: { predicate?: Predicate; limit: number },
): Promise<GraphEdgeRow[]> {
  const conds = [
    eq(relationships.tenantId, tenantId),
    eq(relationships.engagementId, engagementId),
  ];
  if (filter.predicate) conds.push(eq(relationships.predicate, filter.predicate));
  return tx
    .select({
      id: relationships.id,
      fromKind: relationships.fromKind,
      fromId: relationships.fromId,
      predicate: relationships.predicate,
      toKind: relationships.toKind,
      toId: relationships.toId,
      sourceId: relationships.sourceId,
    })
    .from(relationships)
    .where(and(...conds))
    .limit(filter.limit);
}

// --- pipeline health (metadata only) ------------------------------------

/** The last `limit` `extraction_runs` for an engagement, newest first. */
export function selectRecentExtractionRuns(
  tx: DbTransaction,
  tenantId: TenantId,
  engagementId: EngagementId,
  limit: number,
): Promise<ExtractionRunRow[]> {
  return tx
    .select({
      id: extractionRuns.id,
      model: extractionRuns.model,
      promptVersion: extractionRuns.promptVersion,
      costUsd: extractionRuns.costUsd,
      inputSourceIds: extractionRuns.inputSourceIds,
      createdAt: extractionRuns.createdAt,
    })
    .from(extractionRuns)
    .where(
      and(eq(extractionRuns.tenantId, tenantId), eq(extractionRuns.engagementId, engagementId)),
    )
    .orderBy(desc(extractionRuns.createdAt))
    .limit(limit);
}

export interface PipelineRollups {
  totalFacts: number;
  totalEmbeddings: number;
  sourcesByConnector: Record<string, number>;
  totalCostUsd: number;
}

/** Engagement-wide counts for the pipeline dashboard. No content touched. */
export async function selectPipelineRollups(
  tx: DbTransaction,
  tenantId: TenantId,
  engagementId: EngagementId,
): Promise<PipelineRollups> {
  const [factCount] = await tx
    .select({ value: count() })
    .from(facts)
    .where(and(eq(facts.tenantId, tenantId), eq(facts.engagementId, engagementId)));

  const [embeddingCount] = await tx
    .select({ value: count() })
    .from(embeddings)
    .where(and(eq(embeddings.tenantId, tenantId), eq(embeddings.engagementId, engagementId)));

  const bySource = await tx
    .select({ connector: sources.connector, value: count() })
    .from(sources)
    .where(and(eq(sources.tenantId, tenantId), eq(sources.engagementId, engagementId)))
    .groupBy(sources.connector);

  const [cost] = await tx
    .select({ value: sum(extractionRuns.costUsd) })
    .from(extractionRuns)
    .where(
      and(eq(extractionRuns.tenantId, tenantId), eq(extractionRuns.engagementId, engagementId)),
    );

  return {
    totalFacts: factCount?.value ?? 0,
    totalEmbeddings: embeddingCount?.value ?? 0,
    sourcesByConnector: Object.fromEntries(bySource.map((r) => [r.connector, r.value])),
    totalCostUsd: cost?.value == null ? 0 : Number(cost.value),
  };
}
