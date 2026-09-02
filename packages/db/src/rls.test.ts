import { describe, expect, it, vi } from 'vitest';

import type { Database } from './index.js';
import { withTenant } from './index.js';

describe('withTenant', () => {
  it('drops to app_rw and sets app.tenant_id in a transaction, returning the callback result', async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const fakeDb = {
      transaction: (fn: (tx: unknown) => Promise<unknown>) => fn({ execute }),
    } as unknown as Database;

    const result = await withTenant(fakeDb, 'tenant-uuid' as never, async () => 'ok');

    expect(result).toBe('ok');
    expect(execute).toHaveBeenCalledTimes(2);

    const dump = execute.mock.calls
      .map((c) => {
        const stmt = c[0] as { queryChunks?: unknown[] };
        return JSON.stringify(stmt.queryChunks ?? stmt);
      })
      .join(' ');
    expect(dump).toContain('role app_rw');
    expect(dump).toContain('app.tenant_id');
  });
});
