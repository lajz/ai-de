import { randomUUID } from 'node:crypto';

import type { EngagementId, TenantId } from '@fde/core';
import { FakeKeyProvider } from '@fde/crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ConnectorScopeConflictError,
  selectConnectorConfigByScopeRef,
  upsertConnectorConfig,
} from './connector-config.js';
import { createDbClient, type Database } from './client.js';
import { connectorConfig } from './schema/connector-config.js';
import { engagements, tenants } from './schema/tenancy.js';
import { withTenant } from './rls.js';

// Integration test — needs a migrated + hardened database. Skipped unless
// DATABASE_URL is set:
//   docker compose up -d postgres && pnpm db:bootstrap && pnpm db:migrate && pnpm db:harden
//   DATABASE_URL=postgres://postgres:postgres@localhost:5433/fde_dev pnpm test
const url = process.env.DATABASE_URL;

describe.skipIf(!url)('connector_config: external_scope_ref claim + lookup', () => {
  const provider = new FakeKeyProvider();
  let handle: { db: Database; close: () => Promise<void> };
  const tenantA = randomUUID() as TenantId;
  const tenantB = randomUUID() as TenantId;

  async function seedEngagement(tenantId: TenantId): Promise<EngagementId> {
    const engagementId = randomUUID() as EngagementId;
    const { wrappedDek } = await provider.generateDek({
      tenantId,
      engagementId,
      tenantCmkArn: 'fake:cmk',
    });
    await handle.db.insert(engagements).values({
      id: engagementId,
      tenantId,
      endCustomerName: `Acme ${engagementId.slice(0, 8)}`,
      regionPin: 'us',
      retentionPolicy: 'full-retention',
      wrappedDek: Buffer.from(wrappedDek).toString('base64'),
    });
    return engagementId;
  }

  beforeAll(async () => {
    handle = createDbClient({ url: url!, max: 1 });
    await handle.db.insert(tenants).values([
      { id: tenantA, name: 'Tenant A', cmkKeyRef: 'fake:cmk' },
      { id: tenantB, name: 'Tenant B', cmkKeyRef: 'fake:cmk' },
    ]);
  });
  afterAll(async () => {
    await handle.db.delete(engagements).where(eq(engagements.tenantId, tenantA));
    await handle.db.delete(engagements).where(eq(engagements.tenantId, tenantB));
    await handle.db.delete(tenants).where(eq(tenants.id, tenantA));
    await handle.db.delete(tenants).where(eq(tenants.id, tenantB));
    await handle.close();
  });

  it('a second engagement claiming an already-claimed scope is rejected, not silently accepted', async () => {
    const scopeRef = `org-${randomUUID()}`;
    const engagementOne = await seedEngagement(tenantA);
    const engagementTwo = await seedEngagement(tenantB);

    await withTenant(handle.db, tenantA, (tx) =>
      upsertConnectorConfig(
        tx,
        { tenantId: tenantA, engagementId: engagementOne, connector: 'linear' },
        { enabled: true, externalScopeRef: scopeRef },
      ),
    );

    await expect(
      withTenant(handle.db, tenantB, (tx) =>
        upsertConnectorConfig(
          tx,
          { tenantId: tenantB, engagementId: engagementTwo, connector: 'linear' },
          { enabled: true, externalScopeRef: scopeRef },
        ),
      ),
    ).rejects.toBeInstanceOf(ConnectorScopeConflictError);

    // the first claim is untouched
    const match = await selectConnectorConfigByScopeRef(handle.db, 'linear', scopeRef);
    expect(match).toEqual({ tenantId: tenantA, engagementId: engagementOne });
  });

  it('a race between two concurrent claims still lets exactly one win (DB constraint, not an app-level check)', async () => {
    const scopeRef = `org-${randomUUID()}`;
    const engagementOne = await seedEngagement(tenantA);
    const engagementTwo = await seedEngagement(tenantB);

    const claim = (tenantId: TenantId, engagementId: EngagementId) =>
      withTenant(handle.db, tenantId, (tx) =>
        upsertConnectorConfig(
          tx,
          { tenantId, engagementId, connector: 'linear' },
          { enabled: true, externalScopeRef: scopeRef },
        ),
      );

    const results = await Promise.allSettled([
      claim(tenantA, engagementOne),
      claim(tenantB, engagementTwo),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      ConnectorScopeConflictError,
    );

    const match = await selectConnectorConfigByScopeRef(handle.db, 'linear', scopeRef);
    expect([engagementOne, engagementTwo]).toContain(match?.engagementId);
  });

  it('the same engagement re-claiming its own scope (idempotent PUT) is not a conflict', async () => {
    const scopeRef = `org-${randomUUID()}`;
    const engagementId = await seedEngagement(tenantA);

    for (let i = 0; i < 2; i++) {
      await withTenant(handle.db, tenantA, (tx) =>
        upsertConnectorConfig(
          tx,
          { tenantId: tenantA, engagementId, connector: 'linear' },
          { enabled: true, externalScopeRef: scopeRef },
        ),
      );
    }

    const match = await selectConnectorConfigByScopeRef(handle.db, 'linear', scopeRef);
    expect(match).toEqual({ tenantId: tenantA, engagementId });
  });

  it('releasing a claim (externalScopeRef: null) lets a different engagement claim it', async () => {
    const scopeRef = `org-${randomUUID()}`;
    const engagementOne = await seedEngagement(tenantA);
    const engagementTwo = await seedEngagement(tenantB);

    await withTenant(handle.db, tenantA, (tx) =>
      upsertConnectorConfig(
        tx,
        { tenantId: tenantA, engagementId: engagementOne, connector: 'linear' },
        { enabled: true, externalScopeRef: scopeRef },
      ),
    );
    await withTenant(handle.db, tenantA, (tx) =>
      upsertConnectorConfig(
        tx,
        { tenantId: tenantA, engagementId: engagementOne, connector: 'linear' },
        { externalScopeRef: null },
      ),
    );
    await withTenant(handle.db, tenantB, (tx) =>
      upsertConnectorConfig(
        tx,
        { tenantId: tenantB, engagementId: engagementTwo, connector: 'linear' },
        { enabled: true, externalScopeRef: scopeRef },
      ),
    );

    const match = await selectConnectorConfigByScopeRef(handle.db, 'linear', scopeRef);
    expect(match).toEqual({ tenantId: tenantB, engagementId: engagementTwo });
  });

  it('selectConnectorConfigByScopeRef finds a claimed row with no tenant context set at all', async () => {
    const scopeRef = `org-${randomUUID()}`;
    const engagementId = await seedEngagement(tenantA);
    await withTenant(handle.db, tenantA, (tx) =>
      upsertConnectorConfig(
        tx,
        { tenantId: tenantA, engagementId, connector: 'linear' },
        { enabled: true, externalScopeRef: scopeRef },
      ),
    );

    // a bare query on the shared pool — no withTenant, no app.tenant_id set —
    // is exactly the shape the webhook receiver runs before it knows a tenant.
    const match = await selectConnectorConfigByScopeRef(handle.db, 'linear', scopeRef);
    expect(match).toEqual({ tenantId: tenantA, engagementId });

    // a different connector id, or an unclaimed ref, finds nothing
    expect(await selectConnectorConfigByScopeRef(handle.db, 'github', scopeRef)).toBeUndefined();
    expect(
      await selectConnectorConfigByScopeRef(handle.db, 'linear', `unclaimed-${randomUUID()}`),
    ).toBeUndefined();
  });

  /**
   * `selectConnectorConfigByScopeRef` itself can't exercise the RLS policy in
   * this test harness: the pool connects as the Postgres superuser (local
   * dev), which bypasses RLS outright regardless of any policy — the same
   * reason `rls.integration.test.ts` explicitly does `set local role app_rw`
   * before asserting a "no tenant context" read sees nothing. Production's
   * pool authenticates *as* `app_rw` directly, so a bare `db.select()` really
   * does run under the policy there; here we reproduce that by hand to prove
   * `connector_config_scope_lookup` (schema/connector-config.ts) is exactly as
   * narrow as intended.
   */
  it('the scope-lookup RLS policy, run as app_rw: a claimed row is visible tenant-blind, an unclaimed one is not', async () => {
    const scopeRef = `org-${randomUUID()}`;
    const claimedEngagement = await seedEngagement(tenantA);
    const unclaimedEngagement = await seedEngagement(tenantB);
    await withTenant(handle.db, tenantA, (tx) =>
      upsertConnectorConfig(
        tx,
        { tenantId: tenantA, engagementId: claimedEngagement, connector: 'linear' },
        { enabled: true, externalScopeRef: scopeRef },
      ),
    );
    await withTenant(handle.db, tenantB, (tx) =>
      upsertConnectorConfig(
        tx,
        { tenantId: tenantB, engagementId: unclaimedEngagement, connector: 'granola' },
        { enabled: true },
      ),
    );

    const visibleEngagementIds = await handle.db.transaction(async (tx) => {
      await tx.execute(sql`set local role app_rw`);
      // no app.tenant_id set — only `connector_config_scope_lookup` (permissive
      // SELECT, OR'd with the tenant-isolation policy) can make anything visible.
      return tx
        .select({ engagementId: connectorConfig.engagementId })
        .from(connectorConfig)
        .where(sql`engagement_id in (${claimedEngagement}, ${unclaimedEngagement})`)
        .then((rows) => rows.map((r) => r.engagementId));
    });

    expect(visibleEngagementIds).toEqual([claimedEngagement]);
    expect(visibleEngagementIds).not.toContain(unclaimedEngagement);
  });
});
