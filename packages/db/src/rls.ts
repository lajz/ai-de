import { sql } from 'drizzle-orm';

import type { TenantId } from '@fde/core';

import type { Database, DbTransaction } from './client.js';

/**
 * Runs `fn` inside a transaction that (1) drops to the unprivileged `app_rw`
 * role and (2) sets `app.tenant_id`, so every RLS-protected table is scoped to
 * this tenant for its duration. Use this for ALL tenant-facing queries — never a
 * bare `db.select()` against a tenant table.
 *
 * `SET LOCAL ROLE app_rw` is what makes the guarantee hold even when the pool
 * connects as a superuser / table owner (as it does in local dev): those roles
 * bypass RLS, so without the role switch the policies would be silently inert.
 * The connection role must be `app_rw` or a member of it (superusers always are).
 */
export async function withTenant<T>(
  db: Database,
  tenantId: TenantId,
  fn: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    // both reset at COMMIT/ROLLBACK: LOCAL role + transaction-local GUC
    await tx.execute(sql`set local role app_rw`);
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}
