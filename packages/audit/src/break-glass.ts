import type { EngagementId, TenantId } from '@fde/core';
import { breakGlassGrants, type Database, type DbTransaction, withTenant } from '@fde/db';
import { and, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';

import { BreakGlassRequiredError, SelfApprovalError } from './errors.js';
import { logAccess } from './log-access.js';

const DEFAULT_TTL_MINUTES = 60;

/** Enforces the second-person rule: an approver may never be the requester. */
export function assertSecondPerson(requestedBy: string, approvedBy: string): void {
  if (requestedBy === approvedBy) throw new SelfApprovalError(approvedBy);
}

/** Pure so the TTL math is unit-testable without a clock in the database. */
export function computeExpiresAt(ttlMinutes: number, now: Date = new Date()): Date {
  return new Date(now.getTime() + ttlMinutes * 60_000);
}

export interface RequestBreakGlassParams {
  tenantId: TenantId;
  engagementId: EngagementId;
  requestedBy: string;
  reason: string;
  /** minutes the grant is valid for once approved; default 60 */
  ttlMinutes?: number;
}

/** Creates an unapproved grant and logs the request. Returns the grant id. */
export async function requestBreakGlass(
  db: Database,
  params: RequestBreakGlassParams,
): Promise<string> {
  return withTenant(db, params.tenantId, async (tx) => {
    const [grant] = await tx
      .insert(breakGlassGrants)
      .values({
        tenantId: params.tenantId,
        engagementId: params.engagementId,
        requestedBy: params.requestedBy,
        reason: params.reason,
        ttlMinutes: params.ttlMinutes ?? DEFAULT_TTL_MINUTES,
      })
      .returning({ id: breakGlassGrants.id });

    if (!grant) throw new Error('break-glass grant insert returned no row');

    await logAccess(tx, {
      tenantId: params.tenantId,
      engagementId: params.engagementId,
      actorType: 'user',
      actorId: params.requestedBy,
      action: 'break_glass_requested',
      resourceType: 'break_glass_grant',
      resourceId: grant.id,
      reason: params.reason,
    });

    return grant.id;
  });
}

export interface ApproveBreakGlassParams {
  tenantId: TenantId;
  grantId: string;
  approvedBy: string;
}

/**
 * Approves a pending grant, setting `expires_at` from the TTL captured at
 * request time. Rejects self-approval. A grant already approved or revoked is
 * left untouched and writes no new audit row (only a real state change is
 * audited — see `shredEngagement` for the same convention).
 */
export async function approveBreakGlass(
  db: Database,
  params: ApproveBreakGlassParams,
): Promise<void> {
  return withTenant(db, params.tenantId, async (tx) => {
    const [grant] = await tx
      .select({
        requestedBy: breakGlassGrants.requestedBy,
        engagementId: breakGlassGrants.engagementId,
        ttlMinutes: breakGlassGrants.ttlMinutes,
        approvedAt: breakGlassGrants.approvedAt,
        revokedAt: breakGlassGrants.revokedAt,
      })
      .from(breakGlassGrants)
      // RLS (via this `withTenant` transaction) already confines this to
      // `params.tenantId`; the explicit predicate is defense-in-depth so a
      // grant id from another tenant fails closed here even if RLS session
      // state were ever misconfigured.
      .where(
        and(
          eq(breakGlassGrants.id, params.grantId),
          eq(breakGlassGrants.tenantId, params.tenantId),
        ),
      )
      .limit(1)
      // lock against a concurrent approve/revoke of the same grant
      .for('update');

    if (!grant) throw new Error(`break-glass grant ${params.grantId} not found`);
    assertSecondPerson(grant.requestedBy, params.approvedBy);
    if (grant.approvedAt || grant.revokedAt) return;

    const expiresAt = computeExpiresAt(grant.ttlMinutes);

    const updated = await tx
      .update(breakGlassGrants)
      .set({ approvedBy: params.approvedBy, approvedAt: sql`now()`, expiresAt })
      .where(
        and(
          eq(breakGlassGrants.id, params.grantId),
          eq(breakGlassGrants.tenantId, params.tenantId),
          isNull(breakGlassGrants.approvedAt),
        ),
      )
      .returning({ id: breakGlassGrants.id });

    if (updated.length === 0) return;

    await logAccess(tx, {
      tenantId: params.tenantId,
      engagementId: grant.engagementId as EngagementId,
      actorType: 'user',
      actorId: params.approvedBy,
      action: 'break_glass_approved',
      resourceType: 'break_glass_grant',
      resourceId: params.grantId,
    });
  });
}

export interface AssertBreakGlassParams {
  tenantId: TenantId;
  engagementId: EngagementId;
}

/**
 * Throws `BreakGlassRequiredError` unless an approved, unrevoked, unexpired
 * grant exists for this engagement. `tx` must already be tenant-scoped (call
 * from inside `withTenant`/`withEngagement`) so RLS confines the check to the
 * caller's tenant; `tenantId` is also asserted explicitly as defense-in-depth,
 * so a mismatched tenant/engagement pair fails closed even if RLS session
 * state were ever misconfigured.
 */
export async function assertBreakGlass(
  tx: DbTransaction,
  params: AssertBreakGlassParams,
): Promise<void> {
  const [grant] = await tx
    .select({ id: breakGlassGrants.id })
    .from(breakGlassGrants)
    .where(
      and(
        eq(breakGlassGrants.tenantId, params.tenantId),
        eq(breakGlassGrants.engagementId, params.engagementId),
        isNotNull(breakGlassGrants.approvedAt),
        isNull(breakGlassGrants.revokedAt),
        gt(breakGlassGrants.expiresAt, sql`now()`),
      ),
    )
    .limit(1);

  if (!grant) throw new BreakGlassRequiredError(params.engagementId);
}

export interface RevokeBreakGlassParams {
  tenantId: TenantId;
  grantId: string;
  revokedBy: string;
}

/** Revokes a grant early. A no-op (no audit row) if it is already revoked. */
export async function revokeBreakGlass(
  db: Database,
  params: RevokeBreakGlassParams,
): Promise<void> {
  return withTenant(db, params.tenantId, async (tx) => {
    const updated = await tx
      .update(breakGlassGrants)
      .set({ revokedAt: sql`now()` })
      .where(
        and(
          eq(breakGlassGrants.id, params.grantId),
          eq(breakGlassGrants.tenantId, params.tenantId),
          isNull(breakGlassGrants.revokedAt),
        ),
      )
      .returning({ id: breakGlassGrants.id, engagementId: breakGlassGrants.engagementId });

    const revoked = updated[0];
    if (!revoked) return;

    await logAccess(tx, {
      tenantId: params.tenantId,
      engagementId: revoked.engagementId as EngagementId,
      actorType: 'user',
      actorId: params.revokedBy,
      action: 'break_glass_revoked',
      resourceType: 'break_glass_grant',
      resourceId: params.grantId,
    });
  });
}
