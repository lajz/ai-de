import type { EngagementId, TenantId } from '@fde/core';
import {
  createEngagementCipher,
  type EngagementKeyRef,
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

export interface RotateKeyParams extends EngagementRef {
  /** the user id that authorised the rotation */
  actorId: string;
  /** the customer-supplied KMS key ARN to BYOK-wrap the DEK under; `undefined` moves the engagement back onto the platform-managed tenant CMK */
  byokKeyArn: string | undefined;
}

/**
 * On-demand DEK re-wrap: switches which KMS key wraps an engagement's *existing*
 * DEK (BYOK on/off/rotate) without touching a single 🔒 ciphertext row — the DEK
 * itself never changes, only the key it's wrapped under (see `KeyProvider.rewrapDek`'s
 * doc comment for why a fresh DEK here would be wrong). This is the "on-demand
 * re-wrap" half of DEK rotation from the architecture plan; full re-encrypt of
 * existing ciphertext (e.g. if the DEK itself is ever suspected compromised) is
 * explicitly out of scope and deferred.
 *
 * Locking: takes `FOR UPDATE` on the engagement row (stronger than
 * `withEngagement`'s `FOR SHARE`), so it blocks — and is blocked by — any
 * concurrent `withEngagement` for the same engagement. That prevents two race
 * conditions: a reader unwrapping under the old key while this call is
 * mid-write (would look like a torn read, but `FOR UPDATE` vs `FOR SHARE`
 * simply serializes them), and two concurrent rotations stepping on each
 * other's `UPDATE`.
 *
 * Failure mode (this is deliberately the BYOK "verification" step — see the
 * PR description): the KMS `rewrapDek` call — specifically the `Encrypt` under
 * the *new* key — runs and is awaited *before* this function writes anything.
 * If it throws (malformed/nonexistent ARN, the cross-account grant hasn't
 * propagated yet, wrong region, `KeyId` revoked), the whole `withTenant`
 * transaction is rolled back by the thrown error and `wrapped_dek` /
 * `byok_key_arn` are left completely untouched — the engagement keeps working
 * under its previous key. Nothing here can leave the row in a half-rotated
 * state: the UPDATE only happens after `rewrapDek` has already succeeded.
 *
 * Refuses (throws `EngagementShreddedError`) if the engagement is already
 * shredded — there is no DEK left to rotate.
 */
export async function rotateEngagementKey(
  db: Database,
  provider: KeyProvider,
  params: RotateKeyParams,
): Promise<void> {
  return withTenant(db, params.tenantId, async (tx) => {
    const [row] = await tx
      .select({
        status: engagements.status,
        wrappedDek: engagements.wrappedDek,
        byokKeyArn: engagements.byokKeyArn,
        tenantCmkArn: tenants.cmkKeyRef,
      })
      .from(engagements)
      .innerJoin(tenants, eq(tenants.id, engagements.tenantId))
      .where(eq(engagements.id, params.engagementId))
      .limit(1)
      // FOR UPDATE, not FOR SHARE: this call WRITES wrapped_dek/byok_key_arn, so
      // no concurrent withEngagement (FOR SHARE) may proceed with a read until
      // this transaction commits or rolls back — see doc comment above.
      .for('update', { of: engagements });

    if (!row) throw new Error(`engagement ${params.engagementId} not found`);
    if (row.status === 'shredded' || !row.wrappedDek) {
      throw new EngagementShreddedError(params.engagementId);
    }

    const oldRef: EngagementKeyRef = {
      tenantId: params.tenantId,
      engagementId: params.engagementId,
      tenantCmkArn: row.tenantCmkArn,
      byokKeyArn: row.byokKeyArn ?? undefined,
    };
    const newRef: EngagementKeyRef = {
      tenantId: params.tenantId,
      engagementId: params.engagementId,
      tenantCmkArn: row.tenantCmkArn,
      byokKeyArn: params.byokKeyArn,
    };

    // The KMS round-trip happens BEFORE any write. If it throws, control never
    // reaches the UPDATE below and `withTenant` rolls the transaction back —
    // the existing wrapped_dek/byok_key_arn are untouched.
    const rewrapped = await provider.rewrapDek(
      oldRef,
      Buffer.from(row.wrappedDek, 'base64'),
      newRef,
    );

    await tx
      .update(engagements)
      .set({
        wrappedDek: Buffer.from(rewrapped).toString('base64'),
        byokKeyArn: params.byokKeyArn ?? null,
        updatedAt: new Date(),
      })
      .where(eq(engagements.id, params.engagementId));

    await tx.insert(accessLog).values({
      tenantId: params.tenantId,
      engagementId: params.engagementId,
      actorType: 'user',
      actorId: params.actorId,
      action: 'byok_key_rotated',
      resourceType: 'engagement',
      resourceId: params.engagementId,
      reason: params.byokKeyArn
        ? `rotated to customer-supplied key ${params.byokKeyArn}`
        : 'rotated back to the platform-managed tenant key',
    });
  });
}
