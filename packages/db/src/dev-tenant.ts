import { eq } from 'drizzle-orm';

import type { TenantId } from '@fde/core';

import type { Database } from './client.js';
import { tenants } from './schema/index.js';

/**
 * Fixed local tenant name shared by every dev-only entry point that needs a
 * tenant to attach to: `apps/api`'s `/auth/dev-login` (`AuthService`) and
 * `apps/workers/scripts/seed-demo`. Both must resolve to the exact same
 * tenant — a dev-login session that lands in a different tenant than the one
 * a demo was seeded into would see nothing.
 */
export const DEV_TENANT_NAME = 'Local Dev Tenant';

/**
 * Find-or-create `DEV_TENANT_NAME`. Deliberately a bare query against `db` —
 * NOT wrapped in `withTenant` — because tenant provisioning needs the pool's
 * unrestricted local-dev role: `app_rw` has insert/update/delete revoked on
 * `tenants` (`packages/db/sql/harden-rls.sql`), so this only works because the
 * pool connects as a superuser/table owner in local dev (`rls.ts` documents
 * the same thing for `withTenant`'s `SET LOCAL ROLE app_rw`). Same pattern the
 * integration tests use to seed tenants directly.
 */
export async function ensureDevTenant(db: Database): Promise<TenantId> {
  const existing = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.name, DEV_TENANT_NAME))
    .limit(1);
  if (existing[0]) return existing[0].id as TenantId;

  const [created] = await db
    .insert(tenants)
    .values({ name: DEV_TENANT_NAME, cmkKeyRef: 'dev:local' })
    .returning({ id: tenants.id });
  return created!.id as TenantId;
}
