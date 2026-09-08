import { randomUUID } from 'node:crypto';

import type { EngagementId, TenantId, UserId } from '@fde/core';
import { afterAll, describe, expect, it } from 'vitest';

import { AUTHZ_SCHEMA } from './schema.js';
import { SpiceDbAuthzClient } from './spicedb.js';

// Runs only with a real SpiceDB reachable:
//   docker run --rm -p 50051:50051 authzed/spicedb serve \
//     --grpc-preshared-key dev --grpc-no-tls
//   SPICEDB_ENDPOINT=localhost:50051 SPICEDB_TOKEN=dev SPICEDB_INSECURE=true pnpm test
const endpoint = process.env.SPICEDB_ENDPOINT;

describe.skipIf(!endpoint)('SpiceDbAuthzClient (integration)', () => {
  const client = new SpiceDbAuthzClient({
    endpoint: endpoint!,
    token: process.env.SPICEDB_TOKEN ?? 'dev',
    insecure: process.env.SPICEDB_INSECURE !== 'false',
  });
  afterAll(() => client.close());

  it('write schema → write relationships → check → lookup → delete → check again', async () => {
    await client.writeSchema(AUTHZ_SCHEMA);

    const u = `u_${randomUUID()}` as UserId;
    const e = `e_${randomUUID()}` as EngagementId;
    const boss = `u_${randomUUID()}` as UserId;
    const t = `t_${randomUUID()}` as TenantId;

    await client.linkEngagementToTenant(e, t);
    await client.grantEngagementRole(u, e, 'viewer');
    await client.grantTenantRole(boss, t, 'admin');

    const fresh = { consistency: 'fully_consistent' as const };
    const canView = (uid: string) =>
      client.check({
        subject: { type: 'user', id: uid },
        permission: 'view',
        resource: { type: 'engagement', id: e },
        ...fresh,
      });

    expect(await canView(u)).toBe(true);
    expect(await canView(boss)).toBe(true); // via parent_tenant->administer
    expect(await canView(`u_${randomUUID()}`)).toBe(false);

    expect(
      await client.lookupResources({
        subject: { type: 'user', id: u },
        permission: 'view',
        resourceType: 'engagement',
        ...fresh,
      }),
    ).toContain(e);

    await client.revokeEngagementRoles(u, e);
    expect(await canView(u)).toBe(false);
  });
});
