import type { CanonicalRecord, Connector, EngagementId, RawArtifact, TenantId } from '@fde/core';
import type { EngagementCipher } from '@fde/crypto';
import {
  resolveEndpointRef,
  upsertEntityByRef,
  upsertRelationship,
  type DbTransaction,
} from '@fde/db';

import { resolveNormalizedRecords } from './sync-seam.js';

/**
 * Everything `persistGraph` needs from the caller's already-open engagement
 * transaction. Structurally identical to `apps/workers`'
 * `EngagementActivityContext` (and to what a NestJS request-scoped
 * `withEngagement` callback can assemble via `getCipher()`) — either caller
 * satisfies this without an explicit adapter.
 */
export interface GraphWriteContext {
  tenantId: TenantId;
  engagementId: EngagementId;
  cipher: EngagementCipher;
  tx: DbTransaction;
}

/**
 * Metadata-only counts from persisting one run's `normalize` output. No entity
 * names, refs, or bodies — safe to log and to return in workflow history or an
 * HTTP response.
 */
export interface GraphWriteTally {
  /** `person` / `organization` records run through `@fde/identity`'s `resolveEntity` */
  entitiesResolved: number;
  /** `work_item` / `document` / `meeting` records upserted by external ref */
  entitiesUpserted: number;
  /** `relationship` edges newly inserted (dedupe hits excluded) */
  relationshipsUpserted: number;
  /** `relationship` edges skipped because an endpoint ref did not resolve yet */
  relationshipsDeferred: number;
  /** near-duplicate person pairs newly enqueued for human review */
  matchCandidatesQueued: number;
}

export const ZERO_TALLY: GraphWriteTally = {
  entitiesResolved: 0,
  entitiesUpserted: 0,
  relationshipsUpserted: 0,
  relationshipsDeferred: 0,
  matchCandidatesQueued: 0,
};

export const addTally = (a: GraphWriteTally, b: GraphWriteTally): GraphWriteTally => ({
  entitiesResolved: a.entitiesResolved + b.entitiesResolved,
  entitiesUpserted: a.entitiesUpserted + b.entitiesUpserted,
  relationshipsUpserted: a.relationshipsUpserted + b.relationshipsUpserted,
  relationshipsDeferred: a.relationshipsDeferred + b.relationshipsDeferred,
  matchCandidatesQueued: a.matchCandidatesQueued + b.matchCandidatesQueued,
});

/**
 * Persist the canonical graph one artifact's `normalize` produced, inside the
 * caller's engagement transaction (same `ctx.tx` / `ctx.cipher` that just
 * landed the `sources` row).
 *
 * - `person` / `organization` → `resolveNormalizedRecords` (deterministic
 *   identity-tier upsert into `entities` + a fuzzy-match scan that enqueues
 *   near-duplicates for human review — it never auto-merges).
 * - `work_item` / `document` / `meeting` → `upsertEntityByRef` (external-ref key).
 * - `relationship` → resolve both endpoints against entities already in the
 *   graph; insert the edge (stamped with `sourceId`) only if BOTH resolve. An
 *   edge whose endpoint has not been created yet is skipped and counted — a
 *   later artifact in this or a subsequent run may create it. v1 has no
 *   reconciliation pass that retries a deferred edge; that is a documented
 *   follow-up.
 *
 * Entities are written before relationships so an edge between two nodes named
 * in the *same* artifact resolves within this call. `normalize` is pure (the
 * `Connector` contract), so re-running it on a re-ingested artifact is safe;
 * each helper is idempotent, so a second write adds no duplicate rows.
 *
 * Callers own logging (`connector.<id>.graph_persisted`, the returned tally) —
 * this module has no opinion on the log sink, since `apps/workers` logs via
 * Temporal's activity `log` and `apps/api`'s webhook path via a NestJS logger.
 */
export async function persistGraph(
  ctx: GraphWriteContext,
  connector: Connector,
  artifact: RawArtifact,
  sourceId: string,
): Promise<GraphWriteTally> {
  const records: CanonicalRecord[] = connector.normalize(artifact);
  const tally: GraphWriteTally = { ...ZERO_TALLY };

  // person / organization — @fde/identity owns the identity tiers + review queue
  const resolved = await resolveNormalizedRecords(ctx.tx, ctx.tenantId, ctx.engagementId, records);
  tally.entitiesResolved = resolved.length;
  tally.matchCandidatesQueued = resolved.reduce(
    (n, r) => n + r.candidates.filter((c) => c.queued).length,
    0,
  );

  // work_item / document / meeting — keyed directly by external ref
  for (const rec of records) {
    if (rec.kind !== 'entity') continue;
    if (rec.type === 'person' || rec.type === 'organization') continue;
    await upsertEntityByRef(ctx.tx, ctx.tenantId, ctx.engagementId, rec, ctx.cipher);
    tally.entitiesUpserted += 1;
  }

  // relationships — both endpoints must already exist in the graph
  for (const rec of records) {
    if (rec.kind !== 'relationship') continue;
    const from = await resolveEndpointRef(ctx.tx, ctx.tenantId, ctx.engagementId, rec.from);
    const to = await resolveEndpointRef(ctx.tx, ctx.tenantId, ctx.engagementId, rec.to);
    if (!from || !to) {
      tally.relationshipsDeferred += 1;
      continue;
    }
    const { inserted } = await upsertRelationship(ctx.tx, ctx.tenantId, ctx.engagementId, {
      fromKind: from.kind,
      fromId: from.id,
      predicate: rec.predicate,
      toKind: to.kind,
      toId: to.id,
      sourceId,
    });
    if (inserted) tally.relationshipsUpserted += 1;
  }

  return tally;
}
