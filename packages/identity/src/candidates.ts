import type { EntityId, TenantId } from '@fde/core';
import {
  type DbTransaction,
  entities,
  identityReviewQueue,
  type MatchSignals,
  relationships,
} from '@fde/db';
import { and, asc, eq, inArray, ne } from 'drizzle-orm';

import { domainsOf, scoreMatch, sharesExactRef, shouldQueue } from './matching.js';
import { normalizeName } from './normalize.js';

export interface MatchCandidate {
  entityId: EntityId;
  displayName: string;
  score: number;
  signals: MatchSignals;
  /** true when this call enqueued the pair; false when a queue row already existed */
  queued: boolean;
}

const DEFAULT_SCAN_LIMIT = 500;

/**
 * Score one just-resolved `person` against the tenant's other people and enqueue
 * every pair that lands in the fuzzy band (`QUEUE_THRESHOLD` ≤ score < auto-merge,
 * which v1 never reaches). Signals: normalized-name Jaro-Winkler + shared email
 * domain + shared `member_of` organization.
 *
 * Deterministic duplicates are skipped — those are `resolveEntity`'s job. A pair
 * already in the queue (`pending`, `merged`, or `rejected`) is not re-queued
 * (`ON CONFLICT DO NOTHING` on the unordered pair). Takes the caller's open
 * transaction; opens none of its own.
 */
export async function findMatchCandidates(
  tx: DbTransaction,
  tenantId: TenantId,
  entityId: EntityId,
  opts: { limit?: number } = {},
): Promise<MatchCandidate[]> {
  const [self] = await tx
    .select({
      id: entities.id,
      type: entities.type,
      displayName: entities.displayName,
      externalRefs: entities.externalRefs,
    })
    .from(entities)
    .where(and(eq(entities.tenantId, tenantId), eq(entities.id, entityId)))
    .limit(1);
  if (!self || self.type !== 'person') return [];

  const others = await tx
    .select({
      id: entities.id,
      displayName: entities.displayName,
      externalRefs: entities.externalRefs,
    })
    .from(entities)
    .where(
      and(eq(entities.tenantId, tenantId), eq(entities.type, 'person'), ne(entities.id, entityId)),
    )
    // oldest-first so a capped scan is at least deterministic across runs
    .orderBy(asc(entities.createdAt))
    .limit(opts.limit ?? DEFAULT_SCAN_LIMIT);
  if (others.length === 0) return [];

  const selfName = normalizeName(self.displayName);
  const selfDomains = domainsOf(self.externalRefs);
  const orgs = await memberOfOrgs(tx, tenantId, [entityId, ...others.map((o) => o.id)]);
  const selfOrgs = orgs.get(entityId) ?? new Set<string>();

  const out: MatchCandidate[] = [];
  for (const other of others) {
    // an exact shared ref means these should already be one entity — leave it to
    // resolveEntity, never queue it
    if (sharesExactRef(self.externalRefs, other.externalRefs)) continue;

    const sharedDomain = intersects(selfDomains, domainsOf(other.externalRefs));
    const sharedOrg = intersects(selfOrgs, orgs.get(other.id) ?? new Set<string>());
    const { score, signals } = scoreMatch({
      nameA: selfName,
      nameB: normalizeName(other.displayName),
      sharedDomain,
      sharedOrg,
    });
    if (!shouldQueue(score, signals)) continue;

    const queued = await enqueue(tx, tenantId, entityId, other.id as EntityId, score, signals);
    out.push({
      entityId: other.id as EntityId,
      displayName: other.displayName,
      score,
      signals,
      queued,
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

async function enqueue(
  tx: DbTransaction,
  tenantId: TenantId,
  x: EntityId,
  y: EntityId,
  score: number,
  signals: MatchSignals,
): Promise<boolean> {
  const [a, b] = x < y ? [x, y] : [y, x];
  const rows = await tx
    .insert(identityReviewQueue)
    .values({ tenantId, entityAId: a, entityBId: b, score, signals })
    .onConflictDoNothing({
      target: [identityReviewQueue.entityAId, identityReviewQueue.entityBId],
    })
    .returning({ id: identityReviewQueue.id });
  return rows.length > 0;
}

/** `entityId → Set<orgEntityId>` over `(entity)-[member_of]->(entity)` edges. */
async function memberOfOrgs(
  tx: DbTransaction,
  tenantId: TenantId,
  ids: string[],
): Promise<Map<string, Set<string>>> {
  const map = new Map<string, Set<string>>();
  if (ids.length === 0) return map;
  const edges = await tx
    .select({ from: relationships.fromId, to: relationships.toId })
    .from(relationships)
    .where(
      and(
        eq(relationships.tenantId, tenantId),
        eq(relationships.fromKind, 'entity'),
        eq(relationships.predicate, 'member_of'),
        eq(relationships.toKind, 'entity'),
        inArray(relationships.fromId, ids),
      ),
    );
  for (const e of edges) {
    let set = map.get(e.from);
    if (!set) map.set(e.from, (set = new Set()));
    set.add(e.to);
  }
  return map;
}

function intersects(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const v of small) if (large.has(v)) return true;
  return false;
}
