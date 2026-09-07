import type * as FdeDb from '@fde/db';
import { describe, expect, it, vi } from 'vitest';

// Simulates a `withEngagement` that runs `fn` without ever establishing the
// crypto AsyncLocalStorage context (e.g. a future refactor of @fde/db that
// changes that contract). `withEngagementActivity` must fail loudly rather
// than silently handing `fn` a missing/stale cipher. Typed against the real
// `withEngagement` signature (not `unknown`s) so this mock breaks loudly, at
// compile time, if that signature ever changes.
let mockWithEngagementCalls = 0;
vi.mock('@fde/db', async (importOriginal) => {
  const actual = await importOriginal<typeof FdeDb>();
  const withEngagement: typeof FdeDb.withEngagement = (_db, _provider, _ref, fn) => {
    mockWithEngagementCalls++;
    return fn(undefined as unknown as FdeDb.DbTransaction);
  };
  return { ...actual, withEngagement };
});

const { withEngagementActivity } = await import('./engagement-context.js');
const { tryGetCryptoContext } = await import('@fde/crypto');

describe('withEngagementActivity — missing crypto context', () => {
  it('throws instead of silently proceeding without a cipher', async () => {
    // Precondition, not just an assumption: nothing in this test (or the
    // mock above) ever calls `runWithCrypto`, so there is genuinely no ALS
    // store for `withEngagementActivity` to find.
    expect(tryGetCryptoContext()).toBeUndefined();

    const innerFn = vi.fn(async () => 'unreachable');
    await expect(
      withEngagementActivity(
        {} as never,
        {} as never,
        { tenantId: 'tenant-1' as never, engagementId: 'engagement-1' as never },
        innerFn,
      ),
    ).rejects.toThrow(/crypto context missing/);

    // The mocked withEngagement really ran, and the guard fired before ever
    // reaching the caller's callback — this isn't failing for some unrelated
    // reason upstream of the code under test.
    expect(mockWithEngagementCalls).toBe(1);
    expect(innerFn).not.toHaveBeenCalled();
  });
});
