import { ApplicationFailure, heartbeat } from '@temporalio/activity';
import { eq } from 'drizzle-orm';

import type { EngagementId, TenantId } from '@fde/core';
import type { KeyProvider } from '@fde/crypto';
import { logAccess } from '@fde/audit';
import {
  engagements,
  purgeEngagementCiphertext,
  shredEngagement,
  withTenant,
  type Database,
} from '@fde/db';

export interface CryptoShredActivitiesDeps {
  db: Database;
  keyProvider: KeyProvider;
}

export interface ShredEngagementDekInput {
  tenantId: TenantId;
  engagementId: EngagementId;
  actorId: string;
  reason: string;
}

export interface ShredEngagementDekResult {
  /** true if this call performed the shred, false if the engagement was already shredded */
  didShred: boolean;
}

export interface PurgeShreddedCiphertextInput {
  tenantId: TenantId;
  engagementId: EngagementId;
}

export interface PurgeShreddedCiphertextResult {
  totalRowsPurged: number;
  perTable: Record<string, number>;
}

/**
 * The `cryptoShredWorkflow` activities. DI point for `db` / `keyProvider`
 * (both already built in `worker.ts` for the other activity sets).
 *
 * Ids-only payloads throughout — no ciphertext, no plaintext, no key material
 * crosses the workflow↔activity boundary or lands in workflow history.
 */
export function createCryptoShredActivities(deps: CryptoShredActivitiesDeps) {
  /**
   * Calls the same `shredEngagement()` (`@fde/db`) the `POST
   * /engagements/:id/crypto-shred` route already calls synchronously before
   * this workflow is even started. Re-running it here is deliberate, not
   * redundant: `shredEngagement` is idempotent (a no-op, returns `false`, if
   * already shredded), so this activity makes the workflow self-sufficient —
   * it destroys the DEK itself if it hasn't been already, rather than
   * silently trusting that whatever started this workflow already did. That
   * matters because the workflow is a generally-reachable Temporal execution
   * (the Temporal UI, a future scheduled shred, a retry of a differently-shaped
   * caller), not a private extension of the HTTP handler. In the normal API
   * path this call is simply a fast, no-op re-assertion (`didShred: false`) —
   * the real destructive work already happened, synchronously, before
   * Temporal was ever contacted.
   */
  async function shredEngagementDekActivity(
    input: ShredEngagementDekInput,
  ): Promise<ShredEngagementDekResult> {
    const didShred = await shredEngagement(deps.db, input);
    return { didShred };
  }

  /**
   * Storage hygiene, not the security boundary: by the time this activity
   * runs the engagement's DEK is already gone (via `shredEngagementDekActivity`
   * or the API's own synchronous call before this workflow started), so every
   * 🔒 column for this engagement is *already* permanently unreadable. This
   * just stops the database from holding ciphertext nobody can ever open.
   *
   * Deliberately does NOT go through `withEngagementActivity` — the engagement
   * is shredded, so `withEngagement` would throw `EngagementShreddedError`
   * (there's no DEK left to unwrap). `purgeEngagementCiphertext` runs plain
   * `withTenant` transactions instead; it never touches plaintext, only NULLs
   * (or blanks NOT NULL columns to empty) ciphertext columns directly.
   *
   * Batched internally (`purgeEngagementCiphertext`'s own per-table,
   * per-batch transactions) so a large engagement's purge never holds one
   * lock/transaction open for its whole duration; `onBatch` heartbeats so
   * Temporal's activity timeout is measured against progress, not the whole
   * purge. Retry-safe: a batch only ever selects rows that still carry
   * ciphertext, so a retried or re-run purge does no redundant work.
   *
   * Guards against the one way this could go wrong: `purgeEngagementCiphertext`
   * itself has no notion of shred state — it will happily null still-in-use,
   * still-decryptable ciphertext for a live engagement. The workflow's own
   * activity ordering (shred, then purge) is supposed to make that
   * unreachable, but this is a genuinely irreversible operation, so this
   * activity re-checks `engagements.status` itself rather than trusting the
   * caller's ordering alone. A non-`shredded` engagement fails non-retryably —
   * this is a bug in whatever started the workflow, not a transient fault.
   */
  async function purgeShreddedCiphertextActivity(
    input: PurgeShreddedCiphertextInput,
  ): Promise<PurgeShreddedCiphertextResult> {
    const { tenantId, engagementId } = input;

    const status = await withTenant(deps.db, tenantId, async (tx) => {
      const [row] = await tx
        .select({ status: engagements.status })
        .from(engagements)
        .where(eq(engagements.id, engagementId))
        .limit(1);
      return row?.status;
    });
    if (status !== 'shredded') {
      throw ApplicationFailure.create({
        type: 'EngagementNotShredded',
        message: `refusing to purge ciphertext for engagement ${engagementId}: status is ${status ?? 'not found'}, not 'shredded'`,
        nonRetryable: true,
      });
    }

    const result = await purgeEngagementCiphertext(
      deps.db,
      { tenantId, engagementId },
      { onBatch: () => heartbeat() },
    );

    // Distinct, timestamped audit event from the DEK-destruction one — the
    // tenant-visible trail shows "key destroyed" and "ciphertext purged" as
    // two separate moments, per the M4 CryptoShred spec.
    await withTenant(deps.db, tenantId, (tx) =>
      logAccess(tx, {
        tenantId,
        engagementId,
        actorType: 'system',
        action: 'crypto_shred_purge_completed',
        resourceType: 'engagement',
        resourceId: engagementId,
        authzDecision: { ...result },
      }),
    );

    return result;
  }

  return { shredEngagementDekActivity, purgeShreddedCiphertextActivity };
}

export type CryptoShredActivities = ReturnType<typeof createCryptoShredActivities>;
