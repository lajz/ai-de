import type { AccessLogAction, AccessLogId, EngagementId } from '@fde/core';
import { accessLog, type DbTransaction } from '@fde/db';
import { and, desc, eq, gte, lt, lte, or } from 'drizzle-orm';

import { decodeCursor, encodeCursor, resolveLimit } from './cursor.js';
import type { ActorType } from './log-access.js';

export interface ListAccessFilter {
  engagementId?: EngagementId;
  actorId?: string;
  action?: AccessLogAction;
  since?: Date;
  until?: Date;
  /** page size; default 100, clamped to 500 */
  limit?: number;
  cursor?: string;
}

export interface AccessLogRow {
  id: AccessLogId;
  engagementId: EngagementId | null;
  actorType: ActorType;
  actorId: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  authzDecision: Record<string, unknown> | null;
  reason: string | null;
  createdAt: Date;
}

export interface ListAccessResult {
  rows: AccessLogRow[];
  /** present when there may be more rows past this page */
  nextCursor?: string;
}

/**
 * The tenant-facing "who accessed engagement X, when, and why" view — newest
 * first, keyset-paginated over `(created_at, id)`. `tx` must come from an open
 * `withTenant`, which scopes the read to the caller's tenant via RLS.
 */
export async function listAccess(
  tx: DbTransaction,
  filter: ListAccessFilter,
): Promise<ListAccessResult> {
  const limit = resolveLimit(filter.limit);
  const cursor = filter.cursor ? decodeCursor(filter.cursor) : undefined;

  // `and`/`or` ignore `undefined` args at runtime, so unset filters simply drop out.
  const where = and(
    filter.engagementId ? eq(accessLog.engagementId, filter.engagementId) : undefined,
    filter.actorId ? eq(accessLog.actorId, filter.actorId) : undefined,
    filter.action ? eq(accessLog.action, filter.action) : undefined,
    filter.since ? gte(accessLog.createdAt, filter.since) : undefined,
    filter.until ? lte(accessLog.createdAt, filter.until) : undefined,
    // newest-first keyset page: strictly older than the cursor, tie-broken by id
    cursor
      ? or(
          lt(accessLog.createdAt, cursor.createdAt),
          and(eq(accessLog.createdAt, cursor.createdAt), lt(accessLog.id, cursor.id)),
        )
      : undefined,
  );

  const rows = await tx
    .select({
      id: accessLog.id,
      engagementId: accessLog.engagementId,
      actorType: accessLog.actorType,
      actorId: accessLog.actorId,
      action: accessLog.action,
      resourceType: accessLog.resourceType,
      resourceId: accessLog.resourceId,
      authzDecision: accessLog.authzDecision,
      reason: accessLog.reason,
      createdAt: accessLog.createdAt,
    })
    .from(accessLog)
    .where(where)
    .orderBy(desc(accessLog.createdAt), desc(accessLog.id))
    // fetch one extra row to know whether another page follows
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);

  return {
    rows: page as AccessLogRow[],
    nextCursor:
      hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : undefined,
  };
}
