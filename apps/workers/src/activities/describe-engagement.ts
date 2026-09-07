import type { EngagementId, TenantId } from '@fde/core';
import type { KeyProvider } from '@fde/crypto';
import type { Database } from '@fde/db';

import { withEngagementActivity } from './engagement-context.js';

export interface DescribeEngagementInput {
  tenantId: TenantId;
  engagementId: EngagementId;
}

export interface DescribeEngagementResult {
  engagementId: EngagementId;
  /** an encrypt/decrypt round-trip of a fixed constant actually succeeded; never the plaintext itself */
  cipherReady: boolean;
}

const CANARY = 'fde-workers:describe-engagement-canary';

export interface DescribeEngagementDeps {
  db: Database;
  keyProvider: KeyProvider;
}

/**
 * Worked example of the crypto-boundary convention: the workflow that
 * schedules this activity passes only `{ tenantId, engagementId }` (see
 * `pingWorkflow` for the ids-only-payload half of the story); this activity
 * resolves those ids to a live cipher via `withEngagementActivity` and could
 * use `ctx.cipher` / `ctx.tx` to read or write 🔒 columns (`ctx.cipher.decryptString(...)`,
 * `ctx.tx.select(...)`, etc. — see `packages/db/src/engagement.test.ts` for a
 * full read/write example against `facts.body`). It never returns the cipher,
 * or any decrypted body content, from the activity.
 */
export function createDescribeEngagementActivity(deps: DescribeEngagementDeps) {
  return async function describeEngagementActivity(
    input: DescribeEngagementInput,
  ): Promise<DescribeEngagementResult> {
    return withEngagementActivity(deps.db, deps.keyProvider, input, async (ctx) => {
      // Proves the cipher is actually usable, not just constructed — encrypts
      // and decrypts a fixed constant, never anything from `ctx.tx`. Only the
      // pass/fail boolean crosses back out of this activity; the decrypted
      // value is compared and discarded in the same expression, never bound
      // to a variable or logged.
      const ciphertext = await ctx.cipher.encryptString('describe-engagement.canary', CANARY);
      const cipherReady =
        (await ctx.cipher.decryptString('describe-engagement.canary', ciphertext)) === CANARY;
      return { engagementId: ctx.engagementId, cipherReady };
    });
  };
}
