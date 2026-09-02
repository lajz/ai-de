import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import {
  accessLog,
  aclSnapshots,
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
import { TENANT_SCOPED_TABLES } from './tables.js';

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
};

describe('schema', () => {
  it('TENANT_SCOPED_TABLES matches the tenant-scoped table objects', () => {
    expect([...TENANT_SCOPED_TABLES].sort()).toEqual(Object.keys(tenantTables).sort());
  });

  it.each(Object.entries(tenantTables))('%s carries a tenant_id column', (_name, table) => {
    expect(getTableColumns(table)).toHaveProperty('tenantId');
  });

  it('content bodies / quotes / credential refs are `encrypted` (bytea) columns', () => {
    const cases: [Record<string, { getSQLType(): string }>, string][] = [
      [getTableColumns(facts), 'body'],
      [getTableColumns(evidence), 'quote'],
      [getTableColumns(sources), 'rawBody'],
      [getTableColumns(entities), 'body'],
      [getTableColumns(identities), 'connectionSecretRef'],
    ];
    for (const [cols, prop] of cases) {
      // the `encrypted` custom type stores as bytea — a plaintext text/jsonb
      // column would not, so this fails if a 🔒 column is ever downgraded.
      expect(cols[prop]?.getSQLType(), prop).toBe('bytea');
    }
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
