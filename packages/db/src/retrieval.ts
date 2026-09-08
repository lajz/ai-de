import { and, cosineDistance, desc, eq, inArray } from 'drizzle-orm';

import type { EngagementId, TenantId } from '@fde/core';

import type { DbTransaction } from './client.js';
import { embeddings } from './schema/embeddings.js';
import { evidence, facts } from './schema/facts.js';
import { sources } from './schema/sources.js';

/**
 * Engagement read-path queries (`docs/architecture.md` §"Provenance & permission
 * enforcement", step 4).
 *
 * Every function here takes the caller's **already-open** transaction — one from
 * `withTenant` / `withEngagement` (`apps/api`'s `TenantContextInterceptor` opens
 * `withEngagement` for `@EngagementScope` routes; same contract as `@fde/audit`'s
 * `listAccess`). Tenant isolation is enforced **twice**: the `_tenant_isolation`
 * RLS policies keyed on `SET LOCAL app.tenant_id`, *and* an explicit
 * `tenant_id = $tenantId` predicate in every query below (defence in depth — a
 * query here can never widen past the tenant even if it somehow ran outside
 * `withTenant`). Each also pins `engagement_id`. They never open their own
 * transaction. 🔒 columns are returned as ciphertext; the caller decrypts them
 * *after* its authz gate.
 */

/** `facts` for one engagement, newest first (encrypted `body` as-is). */
export function selectEngagementFacts(
  tx: DbTransaction,
  tenantId: TenantId,
  engagementId: EngagementId,
) {
  return tx
    .select({
      id: facts.id,
      type: facts.type,
      summary: facts.summary,
      body: facts.body,
      status: facts.status,
      confidence: facts.confidence,
      occurredAt: facts.occurredAt,
      createdAt: facts.createdAt,
    })
    .from(facts)
    .where(and(eq(facts.tenantId, tenantId), eq(facts.engagementId, engagementId)))
    .orderBy(desc(facts.createdAt));
}

/** `evidence` rows (encrypted `quote` as-is) + source permalink for the given facts. */
export function selectEvidenceForFacts(
  tx: DbTransaction,
  tenantId: TenantId,
  engagementId: EngagementId,
  factIds: string[],
) {
  return tx
    .select({
      factId: evidence.factId,
      sourceId: evidence.sourceId,
      quote: evidence.quote,
      charStart: evidence.charStart,
      charEnd: evidence.charEnd,
      relation: evidence.relation,
      permalink: sources.urlPermalink,
    })
    .from(evidence)
    .innerJoin(
      sources,
      and(eq(sources.engagementId, evidence.engagementId), eq(sources.id, evidence.sourceId)),
    )
    .where(
      and(
        eq(evidence.tenantId, tenantId),
        eq(evidence.engagementId, engagementId),
        inArray(evidence.factId, factIds),
      ),
    );
}

/**
 * pgvector cosine-KNN over one engagement's chunk embeddings. `queryVector` must
 * be `EMBEDDING_DIM`-long. Returns `{ sourceId, chunkRef }` ordered nearest
 * first — no content, so it is safe to run before the authz gate.
 */
export function selectNearestChunks(
  tx: DbTransaction,
  tenantId: TenantId,
  engagementId: EngagementId,
  queryVector: number[],
  limit: number,
) {
  return tx
    .select({ sourceId: embeddings.sourceId, chunkRef: embeddings.chunkRef })
    .from(embeddings)
    .where(and(eq(embeddings.tenantId, tenantId), eq(embeddings.engagementId, engagementId)))
    .orderBy(cosineDistance(embeddings.embedding, queryVector))
    .limit(limit);
}

/**
 * The evidence stamped from the given sources, joined to its fact and source:
 * plaintext `factSummary`, encrypted `factBody` + `quote`, and the source
 * permalink. Feeds the Q&A context block after the authz gate.
 */
export function selectSourceContext(
  tx: DbTransaction,
  tenantId: TenantId,
  engagementId: EngagementId,
  sourceIds: string[],
) {
  return tx
    .select({
      sourceId: evidence.sourceId,
      permalink: sources.urlPermalink,
      quote: evidence.quote,
      factSummary: facts.summary,
      factBody: facts.body,
    })
    .from(evidence)
    .innerJoin(
      sources,
      and(eq(sources.engagementId, evidence.engagementId), eq(sources.id, evidence.sourceId)),
    )
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
    );
}
