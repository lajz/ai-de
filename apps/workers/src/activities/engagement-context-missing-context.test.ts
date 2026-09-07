import type * as FdeDb from '@fde/db';
import { describe, expect, it, vi } from 'vitest';

// Simulates a `withEngagement` that runs `fn` without ever establishing the
// crypto AsyncLocalStorage context (e.g. a future refactor of @fde/db that
// changes that contract). `withEngagementActivity` must fail loudly rather
// than silently handing `fn` a missing/stale cipher. Typed against the real
// `withEngagement` signature (not `unknown`s) so this mock breaks loudly, at
// compile time, if that signature ever changes.
vi.mock('@fde/db', async (importOriginal) => {
  const actual = await importOriginal<typeof FdeDb>();
  const withEngagement: typeof FdeDb.withEngagement = (_db, _provider, _ref, fn) =>
    fn(undefined as unknown as FdeDb.DbTransaction);
  return { ...actual, withEngagement };
});

const { withEngagementActivity } = await import('./engagement-context.js');

describe('withEngagementActivity — missing crypto context', () => {
  it('throws instead of silently proceeding without a cipher', async () => {
    await expect(
      withEngagementActivity(
        {} as never,
        {} as never,
        { tenantId: 'tenant-1' as never, engagementId: 'engagement-1' as never },
        async () => 'unreachable',
      ),
    ).rejects.toThrow(/crypto context missing/);
  });
});
