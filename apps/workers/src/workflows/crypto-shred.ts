import { proxyActivities } from '@temporalio/workflow';

import type { EngagementId, TenantId } from '@fde/core';

// Type-only — workflow code runs in Temporal's deterministic sandbox and must
// not pull in the real activity implementations (@fde/db, postgres).
// Only the input/output shapes.
import type {
  PurgeShreddedCiphertextInput,
  PurgeShreddedCiphertextResult,
  ShredEngagementDekInput,
  ShredEngagementDekResult,
} from '../activities/crypto-shred.js';

const { shredEngagementDekActivity } = proxyActivities<{
  shredEngagementDekActivity(i: ShredEngagementDekInput): Promise<ShredEngagementDekResult>;
}>({
  // One transaction, no external calls — generous ceiling, no heartbeat needed.
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 3 },
});

const { purgeShreddedCiphertextActivity } = proxyActivities<{
  purgeShreddedCiphertextActivity(
    i: PurgeShreddedCiphertextInput,
  ): Promise<PurgeShreddedCiphertextResult>;
}>({
  // Chunked over an unbounded number of batches on a large engagement;
  // heartbeats once per batch (see the activity), so `heartbeatTimeout` catches
  // a stall well before this ceiling.
  startToCloseTimeout: '2 hours',
  heartbeatTimeout: '5 minutes',
  retry: { maximumAttempts: 5 },
});

export interface CryptoShredWorkflowInput {
  tenantId: TenantId;
  engagementId: EngagementId;
  /** the user id that authorised the shred — forwarded to `shredEngagementDekActivity` */
  actorId: string;
  reason: string;
}

export interface CryptoShredWorkflowResult {
  /** whether `shredEngagementDekActivity` itself performed the shred (false when the API already had) */
  didShred: boolean;
  purge: PurgeShreddedCiphertextResult;
}

/**
 * M4's CryptoShred workflow: engagement DEK destruction + async ciphertext
 * purge + a distinct audit entry for each. Two activities, strictly in order —
 * the purge activity requires the DEK to already be gone (it can't open
 * `withEngagement`), so the workflow never starts it concurrently with the
 * shred.
 *
 * In the normal path (`POST /engagements/:id/crypto-shred`), the API has
 * already called `shredEngagement()` directly and synchronously — the
 * *security* guarantee ("revoke a key, the data is now permanently
 * unreadable") never depends on Temporal being reachable. This workflow's
 * first activity re-runs the same idempotent call anyway (see its doc
 * comment) so the workflow is correct and self-sufficient no matter what
 * started it, then runs the purge — which is genuinely fine to be
 * asynchronous, retryable, and slow, since it is storage hygiene, not the
 * security boundary itself.
 */
export async function cryptoShredWorkflow(
  input: CryptoShredWorkflowInput,
): Promise<CryptoShredWorkflowResult> {
  const { didShred } = await shredEngagementDekActivity({
    tenantId: input.tenantId,
    engagementId: input.engagementId,
    actorId: input.actorId,
    reason: input.reason,
  });

  const purge = await purgeShreddedCiphertextActivity({
    tenantId: input.tenantId,
    engagementId: input.engagementId,
  });

  return { didShred, purge };
}
