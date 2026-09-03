import type { EngagementId, TenantId } from '@fde/core';
import {
  createEngagementCipher,
  EngagementShreddedError,
  type KeyProvider,
  runWithCrypto,
} from '@fde/crypto';
import { and, eq, ne } from 'drizzle-orm';

import type { Database, DbTransaction } from './client.js';
import { withTenant } from './rls.js';
import { accessLog } from './schema/audit.js';
import { engagements, tenants } from './schema/tenancy.js';

export interface EngagementRef {
  tenantId: TenantId;
  engagementId: EngagementId;
}

/**
 * Opens a tenant-scoped transaction (`withTenant`) AND an engagement crypto
 * context (`runWithCrypto`), so code inside `fn` can read/write 🔒 columns. Does
 * one KMS unwrap of the engagement DEK; the cipher is discarded when `fn`
 * resolves. Throws `EngagementShreddedError` if the DEK is gone.
 */
export async function withEngagement<T>(
  db: Database,
  provider: KeyProvider,
  ref: EngagementRef,
  fn: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  return withTenant(db, ref.tenantId, async (tx) => {
    const [row] = await tx
      .select({
        status: engagements.status,
        wrappedDek: engagements.wrappedDek,
        byokKeyArn: engagements.byokKeyArn,
        tenantCmkArn: tenants.cmkKeyRef,
      })
      .from(engagements)
      .innerJoin(tenants, eq(tenants.id, engagements.tenantId))
      .where(eq(engagements.id, ref.engagementId))
      .limit(1)
      // Hold a shared lock on the engagement row for the life of this tx: a
      // concurrent shredEngagement (which UPDATEs the row) blocks until the
      // crypto session commits, so `fn` can never write ciphertext under a DEK
      // that has already been destroyed. Other withEngagement sessions still run
      // concurrently.
      .for('share', { of: engagements });

    if (!row) throw new Error(`engagement ${ref.engagementId} not found`);
    if (row.status === 'shredded' || !row.wrappedDek) {
      throw new EngagementShreddedError(ref.engagementId);
    }

    const cipher = await createEngagementCipher(provider, {
      tenantId: ref.tenantId,
      engagementId: ref.engagementId,
      tenantCmkArn: row.tenantCmkArn,
      byokKeyArn: row.byokKeyArn ?? undefined,
      wrappedDek: Buffer.from(row.wrappedDek, 'base64'),
    });

    return runWithCrypto({ ...ref, cipher }, () => fn(tx));
  });
}

export interface ShredParams extends EngagementRef {
  /** the user id that authorised the shred */
  actorId: string;
  reason: string;
}

/**
 * Irreversible. Drops the wrapped DEK, so the engagement's encrypted content can
 * never be decrypted again, and records it in `access_log`. The now-dead
 * ciphertext rows are purged later by a Temporal workflow; revoking a customer's
 * BYOK grant is a separate, customer-initiated step (not required for the shred
 * to be effective — the only wrapped copy of the DEK is gone).
 *
 * @returns true if this call performed the shred, false if it was already shredded
 */
export async function shredEngagement(db: Database, params: ShredParams): Promise<boolean> {
  // the whole body runs in one `withTenant` transaction — the UPDATE and the
  // access_log INSERT are atomic and both RLS-scoped to `params.tenantId`
  return withTenant(db, params.tenantId, async (tx) => {
    const updated = await tx
      .update(engagements)
      .set({ status: 'shredded', wrappedDek: null, byokKeyArn: null, updatedAt: new Date() })
      .where(and(eq(engagements.id, params.engagementId), ne(engagements.status, 'shredded')))
      .returning({ id: engagements.id });

    // Only a real state change is an audit event; a no-op re-shred writes nothing.
    if (updated.length === 0) return false;

    await tx.insert(accessLog).values({
      tenantId: params.tenantId,
      engagementId: params.engagementId,
      actorType: 'user',
      actorId: params.actorId,
      action: 'crypto_shred',
      resourceType: 'engagement',
      resourceId: params.engagementId,
      reason: params.reason,
    });

    return true;
  });
}
