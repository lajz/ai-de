import type * as FdeDb from '@fde/db';
import { describe, expect, it, vi } from 'vitest';

// Simulates a `withEngagement` that runs `fn` without ever establishing the
// crypto AsyncLocalStorage context (e.g. a future refactor of @fde/db that
// changes that contract). `withEngagementActivity` must fail loudly rather
// than silently handing `fn` a missing/stale cipher.
vi.mock('@fde/db', async (importOriginal) => {
  const actual = await importOriginal<typeof FdeDb>();
  return {
    ...actual,
    withEngagement: (
      _db: unknown,
      _provider: unknown,
      _ref: unknown,
      fn: (tx: undefined) => unknown,
    ) => fn(undefined),
  };
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
