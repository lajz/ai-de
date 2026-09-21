import { and, desc, eq, inArray, ne } from 'drizzle-orm';

import type { Ciphertext, EngagementId, EntityType, FactType, TenantId } from '@fde/core';

import type { DbTransaction } from './client.js';
import { evidence, facts } from './schema/facts.js';
import { entities } from './schema/graph.js';
import { sources } from './schema/sources.js';

/**
 * Read queries for `apps/workers`' `AgenticLinkingPipeline` — the identifier
 * scan (deterministic Signal 1) and the semantic-candidate gather (Signal 2)
 * described in `docs/architecture.md`. Same contract as `retrieval.ts` /
 * `lineage.ts`: every function takes the caller's already-open transaction,
 * pins `tenant_id` + `engagement_id`, and never opens its own transaction. 🔒
 * columns come back as ciphertext for the activity to decrypt with the
 * engagement cipher it already holds.
 */

/**
 * Cap on how many other `work_item` entities' encrypted `attributes` get
 * decrypted per identifier scan. There is no cleartext index of
 * `attributes.identifier` to query against (unlike `entities.externalRefs`,
 * which person/organization identity matching keys off) — matching means
 * decrypting candidates and comparing in application code, so this bounds
 * that cost to the engagement's most recently created work items. A match
 * against an older work item beyond this window is a documented v1 gap (see
 * the PR description); a dedicated cleartext identifier index is a follow-up.
 */
export const IDENTIFIER_SCAN_LIMIT = 200;

/** Semantic-candidate fan-out cap before a candidate ever reaches the LLM — mirrors `QA_CANDIDATE_LIMIT`. */
export const AGENTIC_LINKING_CANDIDATE_LIMIT = 8;

export interface WorkItemEntityRow {
  id: string;
  type: EntityType;
  displayName: string;
  attributes: Ciphertext;
  body: Ciphertext | null;
}

/** The just-created work item, by id — `null` if it's gone (deleted) by the time the workflow runs. */
export async function selectWorkItemEntityForLinking(
  tx: DbTransaction,
  tenantId: TenantId,
  engagementId: EngagementId,
  entityId: string,
): Promise<WorkItemEntityRow | undefined> {
  const [row] = await tx
    .select({
      id: entities.id,
      type: entities.type,
      displayName: entities.displayName,
      attributes: entities.attributes,
      body: entities.body,
    })
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

export interface IdentifierScanCandidateRow {
  id: string;
  displayName: string;
  attributes: Ciphertext;
}

/**
 * Other `work_item` entities in the engagement, excluding `excludeId`, newest
 * first, capped at `IDENTIFIER_SCAN_LIMIT`. The caller decrypts `attributes`
 * and compares `.identifier` against the regex-extracted candidate keys.
 */
export function selectOtherWorkItemEntitiesForIdentifierScan(
  tx: DbTransaction,
  tenantId: TenantId,
  engagementId: EngagementId,
  excludeId: string,
): Promise<IdentifierScanCandidateRow[]> {
  return tx
    .select({ id: entities.id, displayName: entities.displayName, attributes: entities.attributes })
    .from(entities)
    .where(
      and(
        eq(entities.tenantId, tenantId),
        eq(entities.engagementId, engagementId),
        eq(entities.type, 'work_item'),
        ne(entities.id, excludeId),
      ),
    )
    .orderBy(desc(entities.createdAt))
    .limit(IDENTIFIER_SCAN_LIMIT);
}

export interface SourceRefRow {
  id: string;
  connector: string;
  externalId: string;
}

/** `{connector, externalId}` for a set of source ids — feeds `resolveEndpointRef` per candidate source. */
export function selectSourceRefsByIds(
  tx: DbTransaction,
  tenantId: TenantId,
  engagementId: EngagementId,
  sourceIds: string[],
): Promise<SourceRefRow[]> {
  if (sourceIds.length === 0) return Promise.resolve([]);
  return tx
    .select({ id: sources.id, connector: sources.connector, externalId: sources.externalId })
    .from(sources)
    .where(
      and(
        eq(sources.tenantId, tenantId),
        eq(sources.engagementId, engagementId),
        inArray(sources.id, sourceIds),
      ),
    );
}

export interface CandidateFactRow {
  id: string;
  type: FactType;
  summary: string;
  body: Ciphertext | null;
}

/**
 * Distinct facts evidenced by any of `sourceIds` (typically the sources behind
 * the nearest embedded chunks to a work item's text), capped at
 * `AGENTIC_LINKING_CANDIDATE_LIMIT`. One row per fact even when several
 * `evidence` rows attest it from these sources — `DISTINCT ON` keeps the
 * first (arbitrary but stable) evidence row's fact fields.
 */
export function selectCandidateFactsBySourceIds(
  tx: DbTransaction,
  tenantId: TenantId,
  engagementId: EngagementId,
  sourceIds: string[],
): Promise<CandidateFactRow[]> {
  if (sourceIds.length === 0) return Promise.resolve([]);
  return (
    tx
      .selectDistinctOn([facts.id], {
        id: facts.id,
        type: facts.type,
        summary: facts.summary,
        body: facts.body,
      })
      .from(evidence)
      .innerJoin(
        facts,
        and(eq(facts.engagementId, evidence.engagementId), eq(facts.id, evidence.factId)),
      )
      .where(
        and(
          eq(evidence.tenantId, tenantId),
          eq(evidence.engagementId, engagementId),
          inArray(evidence.sourceId, sourceIds),
        ),
      )
      // Postgres requires `ORDER BY` to lead with the `DISTINCT ON` expression.
      // Ordering only matters for which single row wins per fact id when several
      // evidence rows attest it — arbitrary-but-stable is fine here.
      .orderBy(facts.id)
      .limit(AGENTIC_LINKING_CANDIDATE_LIMIT)
  );
}
