import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import {
  accessLog,
  aclSnapshots,
  breakGlassGrants,
  embeddings,
  engagements,
  entities,
  evidence,
  extractionRuns,
  facts,
  identities,
  relationships,
  sources,
  users,
} from './index.js';
import { CRYPTO_COLUMNS, TENANT_SCOPED_TABLES } from './tables.js';

const tenantTables = {
  users,
  engagements,
  sources,
  acl_snapshots: aclSnapshots,
  entities,
  relationships,
  facts,
  evidence,
  extraction_runs: extractionRuns,
  embeddings,
  identities,
  access_log: accessLog,
  break_glass_grants: breakGlassGrants,
};

describe('schema', () => {
  it('TENANT_SCOPED_TABLES matches the tenant-scoped table objects', () => {
    expect([...TENANT_SCOPED_TABLES].sort()).toEqual(Object.keys(tenantTables).sort());
  });

  it.each(Object.entries(tenantTables))('%s carries a tenant_id column', (_name, table) => {
    expect(getTableColumns(table)).toHaveProperty('tenantId');
  });

  it('every CRYPTO_COLUMNS spec points at a real `encrypted` (bytea) column', () => {
    // both CRYPTO_COLUMNS and `tenantTables` are keyed by SQL table name
    for (const [name, specs] of Object.entries(CRYPTO_COLUMNS)) {
      const table = tenantTables[name as keyof typeof tenantTables];
      expect(table, name).toBeDefined();
      const cols = getTableColumns(table);
      for (const spec of specs) {
        const col = cols[spec.prop as keyof typeof cols];
        expect(col, `${name}.${spec.prop} missing`).toBeDefined();
        // the `encrypted` custom type stores as bytea — a plaintext jsonb/text
        // column would not, so this fails if a 🔒 column is downgraded.
        expect(col.getSQLType(), `${name}.${spec.prop} is not encrypted`).toBe('bytea');
      }
    }
  });

  it('the sensitive columns from the plan are all in CRYPTO_COLUMNS', () => {
    const flat = Object.entries(CRYPTO_COLUMNS).flatMap(([t, specs]) =>
      specs.map((s) => `${t}.${s.prop}`),
    );
    expect(flat).toEqual(
      expect.arrayContaining([
        'facts.body',
        'evidence.quote',
        'sources.rawBody',
        'identities.connectionSecretRef',
        'acl_snapshots.principalRules',
        'entities.attributes',
        'entities.body',
      ]),
    );
  });

  it('content tables also carry engagement scope', () => {
    // Tables scoped to the tenant but not to one engagement:
    //   users         — a person in the FDE org
    //   engagements    — is itself the scope
    //   identities     — a user's connector credential, reused across engagements
    const tenantOnly = new Set(['users', 'engagements', 'identities']);
    for (const [name, table] of Object.entries(tenantTables)) {
      if (tenantOnly.has(name)) continue;
      expect(getTableColumns(table), name).toHaveProperty('engagementId');
    }
  });
});
