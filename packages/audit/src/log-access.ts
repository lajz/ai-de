import type { AccessLogAction, EngagementId, TenantId } from '@fde/core';
import { accessLog, type DbTransaction } from '@fde/db';

export type ActorType = 'user' | 'system' | 'break_glass';

export interface LogAccessEntry {
  tenantId: TenantId;
  actorType: ActorType;
  actorId?: string;
  action: AccessLogAction;
  resourceType?: string;
  resourceId?: string;
  engagementId?: EngagementId;
  authzDecision?: Record<string, unknown>;
  reason?: string;
}

/**
 * Append-only write to `access_log`. `tx` must come from an open
 * `withTenant`/`withEngagement` — this never opens its own transaction, so
 * callers can log the audit row atomically alongside the state change it
 * describes (see `shredEngagement` in `@fde/db` for the pattern).
 */
export async function logAccess(tx: DbTransaction, entry: LogAccessEntry): Promise<void> {
  await tx.insert(accessLog).values({
    tenantId: entry.tenantId,
    engagementId: entry.engagementId,
    actorType: entry.actorType,
    actorId: entry.actorId,
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    authzDecision: entry.authzDecision,
    reason: entry.reason,
  });
}
