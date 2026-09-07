import type { EngagementId, TenantId } from '@fde/core';
import { tryGetCryptoContext, type EngagementCipher, type KeyProvider } from '@fde/crypto';
import { withEngagement, type Database, type DbTransaction, type EngagementRef } from '@fde/db';

/**
 * The explicit, activity-side analogue of `@fde/crypto`'s `CryptoContext`.
 *
 * The NestJS request path reads its cipher via `getCipher()` off
 * `AsyncLocalStorage`, set once by an interceptor at the top of the request.
 * That doesn't work for Temporal: a workflow's decision to touch 🔒 data and
 * the activity that actually does it are separate RPCs, dispatched by the
 * Temporal server and potentially executed on a different worker process —
 * there is no shared async execution chain for an `AsyncLocalStorage` store to
 * live on. So activities never call `getCipher()`; they take the cipher as an
 * explicit argument instead, via this context.
 */
export interface EngagementActivityContext {
  tenantId: TenantId;
  engagementId: EngagementId;
  cipher: EngagementCipher;
  tx: DbTransaction;
}

/**
 * Activity-side counterpart to `@fde/db`'s `withEngagement`, same shape (db,
 * key provider, ref, callback) — the difference is entirely in what the
 * callback receives. `withEngagement` leaves the cipher on `AsyncLocalStorage`
 * for `fn` to fetch with `getCipher()`; this hands it to `fn` directly as
 * `ctx.cipher`, so nothing inside an activity ever depends on ambient context.
 *
 * The **workflow** that schedules this activity passes only
 * `{ tenantId, engagementId }` — ids, never bodies, never key material — in
 * its (durably persisted, replayable) input. This activity is where those ids
 * get turned into a live cipher, scoped to this one call: `withEngagement`
 * does one KMS unwrap per invocation and the cipher is never returned from the
 * activity or handed to another activity — an activity that also needs it
 * calls `withEngagementActivity` again.
 */
export function withEngagementActivity<T>(
  db: Database,
  provider: KeyProvider,
  ref: EngagementRef,
  fn: (ctx: EngagementActivityContext) => Promise<T>,
): Promise<T> {
  return withEngagement(db, provider, ref, async (tx) => {
    // Reading the ALS store here is safe: we're still inside the synchronous
    // continuation of the `runWithCrypto` call `withEngagement` just made, in
    // the same call stack that set it. We immediately lift the cipher into an
    // explicit argument and never touch `tryGetCryptoContext`/`getCipher`
    // again after this line — nothing downstream of `fn` relies on the store
    // surviving.
    const ctx = tryGetCryptoContext();
    if (!ctx) {
      throw new Error('withEngagementActivity: crypto context missing after withEngagement');
    }
    return fn({ tenantId: ref.tenantId, engagementId: ref.engagementId, cipher: ctx.cipher, tx });
  });
}
