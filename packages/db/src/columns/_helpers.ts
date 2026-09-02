import { sql } from 'drizzle-orm';
import { type AnyPgColumn, pgEnum, pgPolicy, pgRole, timestamp, uuid } from 'drizzle-orm/pg-core';

/** The least-privilege role the application connects as; RLS is enforced against it. */
export const appRole = pgRole('app_rw').existing();

export const pk = () => uuid('id').primaryKey().defaultRandom();

export const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/**
 * `pgEnum` from a `@fde/core` `as const` tuple. The cast keeps the literal union
 * for the column type while satisfying drizzle's `[string, ...string[]]` param.
 */
export const enumFrom = <T extends string>(name: string, values: readonly [T, ...T[]]) =>
  pgEnum(name, values as unknown as [T, ...T[]]);

const tenantMatch = (col: AnyPgColumn) =>
  sql`${col} = nullif(current_setting('app.tenant_id', true), '')::uuid`;

/**
 * Standard per-tenant Row-Level Security: a row is visible only when
 * `app.tenant_id` (set per transaction by `withTenant`) matches the row's tenant.
 * `current_setting(_, true)` yields NULL when never set and `''` after a RESET;
 * `nullif(_, '')` collapses both to NULL, so a query without a tenant context
 * matches nothing (and never errors on an empty ::uuid cast).
 */
export const tenantIsolation = (table: string, tenantCol: AnyPgColumn) =>
  pgPolicy(`${table}_tenant_isolation`, {
    as: 'permissive',
    for: 'all',
    to: appRole,
    using: tenantMatch(tenantCol),
    withCheck: tenantMatch(tenantCol),
  });

/**
 * Same idea for `tenants`, which has no `tenant_id` column — it is scoped by its
 * own primary key, so the app role only ever sees the active tenant's row.
 * Carried in the schema (and therefore the migration) so it is not dependent on
 * `harden-rls.sql`; that script still `ENABLE`/`FORCE`s RLS and revokes writes.
 */
export const selfTenantIsolation = (idCol: AnyPgColumn) =>
  pgPolicy('tenants_self_isolation', {
    as: 'permissive',
    for: 'all',
    to: appRole,
    using: tenantMatch(idCol),
    withCheck: tenantMatch(idCol),
  });
