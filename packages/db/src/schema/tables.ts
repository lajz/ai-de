/**
 * Every table with a `tenant_id` column and a `<name>_tenant_isolation` RLS
 * policy. `sql/harden-rls.sql` and `schema.test.ts` both read this list — keep it
 * in sync when adding a tenant-scoped table.
 */
export const TENANT_SCOPED_TABLES = [
  'users',
  'engagements',
  'sources',
  'acl_snapshots',
  'entities',
  'relationships',
  'facts',
  'evidence',
  'extraction_runs',
  'embeddings',
  'identities',
  'access_log',
] as const;

export type TenantScopedTable = (typeof TENANT_SCOPED_TABLES)[number];

/** Tables the app role may INSERT + SELECT but never UPDATE/DELETE. */
export const APPEND_ONLY_TABLES = ['access_log'] as const;
