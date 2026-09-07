import { randomUUID } from 'node:crypto';

import type { EngagementId, TenantId } from '@fde/core';
import { createDbClient, type Database, engagements, tenants, withTenant } from '@fde/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  approveBreakGlass,
  assertBreakGlass,
  requestBreakGlass,
  revokeBreakGlass,
} from './break-glass.js';
import { BreakGlassRequiredError, SelfApprovalError } from './errors.js';
import { listAccess } from './list-access.js';

// Integration test — needs a migrated + hardened database. Skipped unless
// DATABASE_URL is set:
//   PG_HOST_PORT=5433 docker compose up -d postgres
//   pnpm db:bootstrap && pnpm db:migrate && pnpm db:harden
//   DATABASE_URL=postgres://postgres:postgres@localhost:5433/fde_dev pnpm test
const url = process.env.DATABASE_URL;

describe.skipIf(!url)('break-glass + access log', () => {
  let handle: { db: Database; close: () => Promise<void> };
  const tenantId = randomUUID() as TenantId;

  // Each test gets its own engagement so grants/audit rows never leak across.
  async function seedEngagement(): Promise<EngagementId> {
    const engagementId = randomUUID() as EngagementId;
    await handle.db.insert(engagements).values({
      id: engagementId,
      tenantId,
      endCustomerName: `Acme ${engagementId.slice(0, 8)}`,
      regionPin: 'us',
      retentionPolicy: 'full-retention',
      wrappedDek: 'not-used-by-this-suite',
    });
    return engagementId;
  }

  beforeAll(async () => {
    handle = createDbClient({ url: url!, max: 1 });
    // seed on a superuser connection (DATABASE_URL points at `postgres`), which
    // bypasses RLS — every table here, tenants included, is FORCE RLS.
    await handle.db.insert(tenants).values({ id: tenantId, name: 'T', cmkKeyRef: 'fake:cmk' });
  });

  afterAll(async () => {
    // Dropping the engagements cascades to their break_glass_grants; never
    // DELETE from access_log — it is append-only. The throwaway tenant and its
    // (engagement_id-nulled) audit rows are left behind, as engagement.test.ts
    // does — this suite expects a disposable database.
    await handle.db.delete(engagements).where(eq(engagements.tenantId, tenantId));
    await handle.close();
  });

  it('full lifecycle: request -> approve -> assert passes -> revoke -> assert fails, each logged', async () => {
    const engagementId = await seedEngagement();

    const grantId = await requestBreakGlass(handle.db, {
      tenantId,
      engagementId,
      requestedBy: 'alice',
      reason: 'debugging a customer-reported extraction error',
      ttlMinutes: 60,
    });

    await expect(
      withTenant(handle.db, tenantId, (tx) => assertBreakGlass(tx, { tenantId, engagementId })),
    ).rejects.toThrow(BreakGlassRequiredError);

    await approveBreakGlass(handle.db, { tenantId, grantId, approvedBy: 'bob' });

    await withTenant(handle.db, tenantId, (tx) => assertBreakGlass(tx, { tenantId, engagementId }));

    await revokeBreakGlass(handle.db, { tenantId, grantId, revokedBy: 'bob' });

    await expect(
      withTenant(handle.db, tenantId, (tx) => assertBreakGlass(tx, { tenantId, engagementId })),
    ).rejects.toThrow(BreakGlassRequiredError);

    const { rows } = await withTenant(handle.db, tenantId, (tx) =>
      listAccess(tx, { engagementId }),
    );
    expect(rows.map((r) => r.action)).toEqual([
      'break_glass_revoked',
      'break_glass_approved',
      'break_glass_requested',
    ]);
    expect(rows.every((r) => r.engagementId === engagementId)).toBe(true);
  });

  it('assertBreakGlass throws when no grant exists at all', async () => {
    const engagementId = await seedEngagement();
    await expect(
      withTenant(handle.db, tenantId, (tx) => assertBreakGlass(tx, { tenantId, engagementId })),
    ).rejects.toThrow(BreakGlassRequiredError);
  });

  it('assertBreakGlass throws when the grant has expired', async () => {
    const engagementId = await seedEngagement();
    const grantId = await requestBreakGlass(handle.db, {
      tenantId,
      engagementId,
      requestedBy: 'alice',
      reason: 'expiry test',
      ttlMinutes: 60,
    });
    await approveBreakGlass(handle.db, { tenantId, grantId, approvedBy: 'bob' });

    // force it into the past, bypassing the package API on purpose
    await withTenant(handle.db, tenantId, (tx) =>
      tx.execute(
        sql`update break_glass_grants set expires_at = now() - interval '1 minute' where id = ${grantId}`,
      ),
    );

    await expect(
      withTenant(handle.db, tenantId, (tx) => assertBreakGlass(tx, { tenantId, engagementId })),
    ).rejects.toThrow(BreakGlassRequiredError);
  });

  it('assertBreakGlass throws when the grant was revoked', async () => {
    const engagementId = await seedEngagement();
    const grantId = await requestBreakGlass(handle.db, {
      tenantId,
      engagementId,
      requestedBy: 'alice',
      reason: 'revoke test',
    });
    await approveBreakGlass(handle.db, { tenantId, grantId, approvedBy: 'bob' });
    await revokeBreakGlass(handle.db, { tenantId, grantId, revokedBy: 'bob' });

    await expect(
      withTenant(handle.db, tenantId, (tx) => assertBreakGlass(tx, { tenantId, engagementId })),
    ).rejects.toThrow(BreakGlassRequiredError);
  });

  it('rejects self-approval and leaves the grant unapproved', async () => {
    const engagementId = await seedEngagement();
    const grantId = await requestBreakGlass(handle.db, {
      tenantId,
      engagementId,
      requestedBy: 'alice',
      reason: 'self-approval attempt',
    });

    await expect(
      approveBreakGlass(handle.db, { tenantId, grantId, approvedBy: 'alice' }),
    ).rejects.toThrow(SelfApprovalError);

    await expect(
      withTenant(handle.db, tenantId, (tx) => assertBreakGlass(tx, { tenantId, engagementId })),
    ).rejects.toThrow(BreakGlassRequiredError);
  });

  it('listAccess filters by action and paginates with a keyset cursor', async () => {
    const engagementId = await seedEngagement();
    // three request/approve/revoke cycles -> 9 access_log rows for this engagement
    for (let i = 0; i < 3; i++) {
      const grantId = await requestBreakGlass(handle.db, {
        tenantId,
        engagementId,
        requestedBy: 'alice',
        reason: `cycle ${i}`,
      });
      await approveBreakGlass(handle.db, { tenantId, grantId, approvedBy: 'bob' });
      await revokeBreakGlass(handle.db, { tenantId, grantId, revokedBy: 'bob' });
    }

    const onlyRequested = await withTenant(handle.db, tenantId, (tx) =>
      listAccess(tx, { engagementId, action: 'break_glass_requested' }),
    );
    expect(onlyRequested.rows).toHaveLength(3);
    expect(onlyRequested.rows.every((r) => r.action === 'break_glass_requested')).toBe(true);

    const page1 = await withTenant(handle.db, tenantId, (tx) =>
      listAccess(tx, { engagementId, limit: 4 }),
    );
    expect(page1.rows).toHaveLength(4);
    expect(page1.nextCursor).toBeDefined();

    const page2 = await withTenant(handle.db, tenantId, (tx) =>
      listAccess(tx, { engagementId, limit: 4, cursor: page1.nextCursor }),
    );
    expect(page2.rows).toHaveLength(4);

    const page3 = await withTenant(handle.db, tenantId, (tx) =>
      listAccess(tx, { engagementId, limit: 4, cursor: page2.nextCursor }),
    );
    expect(page3.rows).toHaveLength(1);
    expect(page3.nextCursor).toBeUndefined();

    const allIds = [...page1.rows, ...page2.rows, ...page3.rows].map((r) => r.id);
    expect(new Set(allIds).size).toBe(9);
  });
});
