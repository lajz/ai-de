# @fde/authz

SpiceDB schema + a typed check/write wrapper (`AuthzClient`) for the platform's
authorization. ROADMAP #10 — **platform-role checks only**. Per-source ACL
mirroring (`slack_channel:C123#member@user:U9`, retrieval as the asking user) is
M5; the schema and wrapper are shaped so adding it is purely additive (see the
marked spots in `schema.zed` / `src/schema.ts` / `src/in-memory.ts`).

## Schema

```
definition user {}
definition tenant     { relation admin/member: user;  permission administer = admin;  permission belong = admin + member }
definition engagement {
  relation parent_tenant: tenant
  relation admin/member/viewer: user
  permission view       = viewer + member + admin + parent_tenant->administer
  permission contribute = member + admin
  permission administer = admin
}
```

`AUTHZ_SCHEMA` (in `src/schema.ts`) is authoritative — it's what `writeSchema`
pushes. `schema.zed` is a byte-identical copy for `zed` tooling / editors;
`in-memory.test.ts` asserts they match. Bump `SCHEMA_VERSION` on any change.

## `AuthzClient`

An abstract class: five primitives + typed helpers on top.

| primitive             | notes                                      |
| --------------------- | ------------------------------------------ |
| `check`               | defaults to `minimize_latency` consistency |
| `writeRelationships`  | CREATE / TOUCH / DELETE, one transaction   |
| `deleteRelationships` | bulk delete by filter                      |
| `lookupResources`     | resource IDs a subject has a permission on |
| `writeSchema`         | replace the stored schema                  |

Helpers: `canViewEngagement` / `canContributeToEngagement` /
`canAdministerEngagement` / `canAdministerTenant` / `isTenantMember`,
`listViewableEngagements`, `grantEngagementRole` / `revokeEngagementRoles`,
`grantTenantRole` / `revokeTenantRoles`, `linkEngagementToTenant`.

### Implementations

- **`InMemoryAuthzClient`** — tuples in a Map, resolved by a small recursive
  expander (handles the `parent_tenant->administer` arrow, cycle-guarded). Backs
  every unit test and local dev.
- **`SpiceDbAuthzClient`** — `@authzed/authzed-node` gRPC. Config
  `{ endpoint, token, insecure }`.

### Consistency

`check` / `lookupResources` default to **`minimize_latency`** — the fastest
cached snapshot. Good enough for a read-path gate: a just-granted role appearing
a moment late is fine, and a stale _revoke_ is backstopped by Postgres RLS
underneath. Pass `consistency: 'fully_consistent'` when a read must reflect a
write it just made (tests, an admin screen reading back a grant). Schema and
relationship writes are always transactional server-side — no knob.

### `createAuthzClientFromEnv(env?)`

`SpiceDbAuthzClient` when `SPICEDB_ENDPOINT` **and** `SPICEDB_TOKEN` are set,
else `InMemoryAuthzClient` with a one-line stderr warning — **except** under
`NODE_ENV=production`, where the in-memory fallback throws.

## Running SpiceDB locally

```bash
docker run --rm -p 50051:50051 authzed/spicedb serve \
  --grpc-preshared-key dev --grpc-no-tls

export SPICEDB_ENDPOINT=localhost:50051 SPICEDB_TOKEN=dev SPICEDB_INSECURE=true
pnpm --filter @fde/authz schema:push        # push AUTHZ_SCHEMA
pnpm test                                    # runs spicedb.integration.test.ts too
```

Without those env vars the integration test is skipped and `schema:push` is a
no-op against a throwaway in-memory client. Authzed Cloud (T0): set
`SPICEDB_ENDPOINT=<tenant>.grpc.authzed.com:443`, `SPICEDB_TOKEN=<token>`, no
`SPICEDB_INSECURE`.
