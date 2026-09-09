import type { EngagementId, EntityId, EntityType, IdentityReviewId, TenantId } from '@fde/core';
import { logAccess } from '@fde/audit';
import {
  type DbTransaction,
  entities,
  identityReviewQueue,
  type IdentityReviewStatus,
  type MatchSignals,
  relationships,
} from '@fde/db';
import { and, asc, desc, eq, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import { IdentityError } from './errors.js';
import { unionRefs } from './matching.js';

/**
 * Rows whose `entity_{a,b}_id` is repointed from the merged entity onto the kept
 * entity by `applyMatchDecision('merge')`. `relationships` endpoints are
 * polymorphic (no FK), so the repoint is manual + collision-guarded against
 * `relationships_edge_uq`. `evidence` and `facts` carry no entity FK in the v1
 * schema — listed here so a schema that adds one updates this set too.
 */
export const FK_REPOINT_TARGETS = ['relationships.from_id', 'relationships.to_id'] as const;

export interface PendingMatch {
  id: IdentityReviewId;
  score: number;
  signals: MatchSignals;
  createdAt: Date;
  entityA: { id: EntityId; displayName: string; type: EntityType };
  entityB: { id: EntityId; displayName: string; type: EntityType };
}

/** Pending fuzzy matches for the tenant, best score first. `tx` from `withTenant`. */
export async function listPendingMatches(
  tx: DbTransaction,
  tenantId: TenantId,
): Promise<PendingMatch[]> {
  const ea = alias(entities, 'ea');
  const eb = alias(entities, 'eb');
  const rows = await tx
    .select({
      id: identityReviewQueue.id,
      score: identityReviewQueue.score,
      signals: identityReviewQueue.signals,
      createdAt: identityReviewQueue.createdAt,
      aId: ea.id,
      aName: ea.displayName,
      aType: ea.type,
      bId: eb.id,
      bName: eb.displayName,
      bType: eb.type,
    })
    .from(identityReviewQueue)
    .innerJoin(ea, eq(ea.id, identityReviewQueue.entityAId))
    .innerJoin(eb, eq(eb.id, identityReviewQueue.entityBId))
    .where(
      and(eq(identityReviewQueue.tenantId, tenantId), eq(identityReviewQueue.status, 'pending')),
    )
    .orderBy(desc(identityReviewQueue.score), asc(identityReviewQueue.createdAt));

  return rows.map((r) => ({
    id: r.id as IdentityReviewId,
    score: r.score,
    signals: r.signals,
    createdAt: r.createdAt,
    entityA: { id: r.aId as EntityId, displayName: r.aName, type: r.aType },
    entityB: { id: r.bId as EntityId, displayName: r.bName, type: r.bType },
  }));
}

export type MatchDecision = 'merge' | 'reject';

export interface ApplyMatchDecisionParams {
  queueId: IdentityReviewId;
  decision: MatchDecision;
  /** actor id recorded on the queue row and in `access_log` */
  decidedBy: string;
  /** on `merge`, which side of the pair to keep — must be one of the pair; defaults to entity A */
  keepEntityId?: EntityId;
}

export interface ApplyMatchDecisionResult {
  decision: MatchDecision;
  status: IdentityReviewStatus;
  keptEntityId: EntityId | null;
  mergedEntityId: EntityId | null;
  repointedRelationships: number;
}

/**
 * Act on one queued match. `reject` records the negative so the pair is never
 * re-queued. `merge` folds the dropped entity into the kept one:
 *
 *  1. union the cleartext `external_refs` onto the kept entity;
 *  2. repoint graph edges (`FK_REPOINT_TARGETS`), dropping any that would
 *     duplicate an edge the kept entity already has;
 *  3. delete the dropped entity — the `identity_review_queue` FK cascade then
 *     removes this row and any other pending pair that referenced it.
 *
 * v1 `merge` requires both entities to be in the **same engagement** (throws
 * otherwise): the entity crypto + graph scope is the engagement, so a
 * cross-engagement fold would need both engagements' DEKs and would leave
 * repointed edges straddling engagements. A cross-engagement pair can still be
 * `reject`ed or left pending for a follow-up that handles it explicitly. Even
 * within one engagement v1 does not merge the dropped entity's encrypted
 * `attributes` / `body` — this call holds no crypto context, so the kept
 * entity's encrypted fields stand.
 *
 * Every decision writes one `access_log` row (`identity_merge`). `tx` must come
 * from an open `withTenant` so the whole thing is one atomic, tenant-scoped unit;
 * authn + "may this actor merge identities" is the caller's job (as with every
 * `@fde/db` / `@fde/audit` helper) — `decidedBy` here is only the audit label.
 */
export async function applyMatchDecision(
  tx: DbTransaction,
  tenantId: TenantId,
  params: ApplyMatchDecisionParams,
): Promise<ApplyMatchDecisionResult> {
  const [row] = await tx
    .select()
    .from(identityReviewQueue)
    .where(
      and(eq(identityReviewQueue.tenantId, tenantId), eq(identityReviewQueue.id, params.queueId)),
    )
    .limit(1);
  if (!row) throw new IdentityError(`review-queue row ${params.queueId} not found`);
  if (row.status !== 'pending') {
    throw new IdentityError(`review-queue row ${params.queueId} is already ${row.status}`);
  }
  const now = new Date();
  const entityAId = row.entityAId as EntityId;
  const entityBId = row.entityBId as EntityId;

  if (params.decision === 'reject') {
    await tx
      .update(identityReviewQueue)
      .set({ status: 'rejected', decidedBy: params.decidedBy, decidedAt: now })
      .where(and(eq(identityReviewQueue.tenantId, tenantId), eq(identityReviewQueue.id, row.id)));
    await logAccess(tx, {
      tenantId,
      actorType: 'user',
      actorId: params.decidedBy,
      action: 'identity_merge',
      resourceType: 'identity_review_queue',
      resourceId: row.id,
      authzDecision: { decision: 'reject', entityAId, entityBId, score: row.score },
      reason: 'reviewer rejected the fuzzy match',
    });
    return {
      decision: 'reject',
      status: 'rejected',
      keptEntityId: null,
      mergedEntityId: null,
      repointedRelationships: 0,
    };
  }

  const keep = params.keepEntityId ?? entityAId;
  if (keep !== entityAId && keep !== entityBId) {
    throw new IdentityError(`keepEntityId ${keep} is not part of pair ${row.id}`);
  }
  const drop = keep === entityAId ? entityBId : entityAId;

  const [keepEntity] = await tx
    .select({
      id: entities.id,
      engagementId: entities.engagementId,
      externalRefs: entities.externalRefs,
    })
    .from(entities)
    .where(and(eq(entities.tenantId, tenantId), eq(entities.id, keep)))
    .limit(1);
  const [dropEntity] = await tx
    .select({
      id: entities.id,
      engagementId: entities.engagementId,
      externalRefs: entities.externalRefs,
    })
    .from(entities)
    .where(and(eq(entities.tenantId, tenantId), eq(entities.id, drop)))
    .limit(1);
  if (!keepEntity || !dropEntity) throw new IdentityError('one side of the merge no longer exists');
  if (keepEntity.engagementId !== dropEntity.engagementId) {
    throw new IdentityError(
      `cross-engagement merge is not supported in v1 (pair ${row.id}); reject it or leave it pending`,
    );
  }

  await tx
    .update(entities)
    .set({
      externalRefs: unionRefs(keepEntity.externalRefs, dropEntity.externalRefs),
      updatedAt: now,
    })
    .where(and(eq(entities.tenantId, tenantId), eq(entities.id, keep)));

  const repointedRelationships = await repointEntityEdges(tx, tenantId, drop, keep);

  // Stamp the decision. In the v1 schema the row is then swept by the FK cascade
  // when `drop` is deleted below — the durable record is the `access_log` entry —
  // but the explicit status write keeps the intent correct if that FK ever
  // becomes `ON DELETE SET NULL`.
  await tx
    .update(identityReviewQueue)
    .set({ status: 'merged', decidedBy: params.decidedBy, decidedAt: now })
    .where(and(eq(identityReviewQueue.tenantId, tenantId), eq(identityReviewQueue.id, row.id)));

  await logAccess(tx, {
    tenantId,
    actorType: 'user',
    actorId: params.decidedBy,
    action: 'identity_merge',
    engagementId: keepEntity.engagementId as EngagementId,
    resourceType: 'entities',
    resourceId: keep,
    authzDecision: {
      decision: 'merge',
      queueId: row.id,
      keptEntityId: keep,
      mergedEntityId: drop,
      score: row.score,
      repointedRelationships,
    },
  });

  // cascades through identity_review_queue.entity_{a,b}_id → removes this row too
  await tx.delete(entities).where(and(eq(entities.tenantId, tenantId), eq(entities.id, drop)));

  return {
    decision: 'merge',
    status: 'merged',
    keptEntityId: keep,
    mergedEntityId: drop,
    repointedRelationships,
  };
}

/**
 * Move every `relationships` edge that touches `from` (as an `entity` endpoint)
 * onto `to`. Recreate-then-delete so a repointed edge that collides with an
 * existing one (`relationships_edge_uq`) is silently coalesced rather than
 * raising. Returns the number of edges actually moved.
 */
async function repointEntityEdges(
  tx: DbTransaction,
  tenantId: TenantId,
  from: EntityId,
  to: EntityId,
): Promise<number> {
  const touchesFrom = or(
    and(eq(relationships.fromKind, 'entity'), eq(relationships.fromId, from)),
    and(eq(relationships.toKind, 'entity'), eq(relationships.toId, from)),
  );
  const edges = await tx
    .select()
    .from(relationships)
    .where(and(eq(relationships.tenantId, tenantId), touchesFrom));

  let moved = 0;
  for (const e of edges) {
    const fromId = e.fromKind === 'entity' && e.fromId === from ? to : e.fromId;
    const toId = e.toKind === 'entity' && e.toId === from ? to : e.toId;
    // a self-edge after repoint (e.g. A member_of A) is meaningless — drop it
    if (e.fromKind === e.toKind && fromId === toId) continue;
    const inserted = await tx
      .insert(relationships)
      .values({
        tenantId,
        engagementId: e.engagementId,
        fromKind: e.fromKind,
        fromId,
        predicate: e.predicate,
        toKind: e.toKind,
        toId,
        sourceId: e.sourceId,
      })
      .onConflictDoNothing({
        target: [
          relationships.fromKind,
          relationships.fromId,
          relationships.predicate,
          relationships.toKind,
          relationships.toId,
        ],
      })
      .returning({ id: relationships.id });
    if (inserted.length > 0) moved += 1;
  }

  await tx.delete(relationships).where(and(eq(relationships.tenantId, tenantId), touchesFrom));
  return moved;
}
