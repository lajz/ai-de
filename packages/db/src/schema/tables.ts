import type { EncryptedColumnSpec } from '@fde/core';

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
  'break_glass_grants',
] as const;

export type TenantScopedTable = (typeof TENANT_SCOPED_TABLES)[number];

/** Tables the app role may INSERT + SELECT but never UPDATE/DELETE. */
export const APPEND_ONLY_TABLES = ['access_log'] as const;

/**
 * Application-layer-encrypted columns, keyed by table name. The repository layer
 * runs `encryptRow` / `decryptRow` (`@fde/crypto`) with these specs. Property
 * names are JS/Drizzle names; paths feed the encryption context (AAD).
 */
export const CRYPTO_COLUMNS = {
  facts: [{ prop: 'body', path: 'facts.body', codec: 'string' }],
  evidence: [{ prop: 'quote', path: 'evidence.quote', codec: 'string' }],
  sources: [{ prop: 'rawBody', path: 'sources.raw_body', codec: 'string' }],
  acl_snapshots: [{ prop: 'principalRules', path: 'acl_snapshots.principal_rules', codec: 'json' }],
  entities: [
    { prop: 'attributes', path: 'entities.attributes', codec: 'json' },
    { prop: 'body', path: 'entities.body', codec: 'string' },
  ],
  identities: [
    {
      prop: 'connectionSecretRef',
      path: 'identities.connection_secret_ref',
      codec: 'string',
    },
  ],
} as const satisfies Record<string, readonly EncryptedColumnSpec[]>;

export type CryptoScopedTable = keyof typeof CRYPTO_COLUMNS;
