import { randomUUID } from 'node:crypto';

import type { TenantId } from '@fde/core';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDbClient, type Database } from './client.js';
import { withTenant } from './rls.js';
import { tenants, users } from './schema/index.js';

// Integration test — needs a migrated + hardened database. Skipped unless
// DATABASE_URL is set:
//   docker compose up -d postgres && pnpm db:bootstrap && pnpm db:migrate && pnpm db:harden
//   DATABASE_URL=postgres://postgres:postgres@localhost:5433/fde_dev pnpm test
const url = process.env.DATABASE_URL;

describe.skipIf(!url)('withTenant RLS isolation', () => {
  let handle: { db: Database; close: () => Promise<void> };
  const tenantA = randomUUID() as TenantId;
  const tenantB = randomUUID() as TenantId;

  beforeAll(async () => {
    handle = createDbClient({ url: url!, max: 1 });
    // seed on the superuser connection (bypasses RLS)
    await handle.db.insert(tenants).values([
      { id: tenantA, name: 'A', cmkKeyRef: 'fake:a' },
      { id: tenantB, name: 'B', cmkKeyRef: 'fake:b' },
    ]);
    await handle.db.insert(users).values({ tenantId: tenantA, email: 'a@example.com' });
  });

  afterAll(async () => {
    await handle.db.delete(users).where(eq(users.tenantId, tenantA));
    await handle.db.delete(tenants).where(sql`id in (${tenantA}, ${tenantB})`);
    await handle.close();
  });

  it('scopes reads to the active tenant even when the pool connects as a superuser', async () => {
    const asA = await withTenant(handle.db, tenantA, (tx) =>
      tx.select({ email: users.email }).from(users),
    );
    expect(asA.map((r) => r.email)).toEqual(['a@example.com']);

    // tenant B asks for users; A's row is invisible, and no error is raised
    const asB = await withTenant(handle.db, tenantB, (tx) =>
      tx.select({ email: users.email }).from(users),
    );
    expect(asB).toEqual([]);
  });

  it('rejects a write for another tenant with an RLS policy violation (WITH CHECK)', async () => {
    await expect(
      withTenant(handle.db, tenantB, (tx) =>
        tx.insert(users).values({ tenantId: tenantA, email: 'spoof@example.com' }),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('reads nothing (and does not error) when no tenant context is set', async () => {
    // the RLS predicate is `tenant_id = nullif(current_setting(..., true), '')::uuid`
    // → NULL when unset → matches no row, rather than raising
    const rows = await handle.db.transaction(async (tx) => {
      await tx.execute(sql`set local role app_rw`);
      return tx.select({ email: users.email }).from(users);
    });
    expect(rows).toEqual([]);
  });

  it('keeps access_log append-only for the app role', async () => {
    await expect(
      withTenant(handle.db, tenantA, (tx) => tx.execute(sql`update access_log set reason = 'x'`)),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      withTenant(handle.db, tenantA, (tx) => tx.execute(sql`delete from access_log`)),
    ).rejects.toThrow(/permission denied/i);
  });

  it('locks the tenants row to the active tenant and forbids writing it', async () => {
    const seenByA = await withTenant(handle.db, tenantA, (tx) =>
      tx.select({ name: tenants.name }).from(tenants),
    );
    expect(seenByA.map((r) => r.name)).toEqual(['A']);

    await expect(
      withTenant(handle.db, tenantA, (tx) =>
        tx.execute(sql`update tenants set name = 'renamed' where id = ${tenantA}`),
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});
