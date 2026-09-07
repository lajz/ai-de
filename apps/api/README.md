# @fde/api

NestJS HTTP API — WorkOS auth, the request-scoped tenant/engagement context
seam, and the minimal M1 read routes. Every later feature (connectors, the web
app, retrieval) hangs off the seam described below.

```bash
pnpm --filter @fde/api dev       # tsx watch, needs DATABASE_URL (+ FDE_FAKE_KMS=true for no-AWS)
pnpm --filter @fde/api build     # tsc -p tsconfig.json
pnpm --filter @fde/api start     # node dist/main.js
pnpm --filter @fde/api openapi   # regenerate apps/api/openapi.json
```

## The request-context seam

The one thing to get right. Two app-wide providers, wired in
`request-context/request-context.module.ts`:

### 1. `TenantContextGuard` (runs first — before any interceptor)

Resolves the request's session (`Authorization: Bearer <token>` or the
`fde_session` cookie) to a `{ tenantId, userId }`. No session, an unknown token,
or a session revoked by SCIM deprovision → **401, before a database connection
is ever opened**. `@Public()` routes (`/healthz`, `/auth/*`, `/webhooks/workos`)
skip through. On success the `Session` is stashed on the request; the guard does
no DB work itself.

### 2. `TenantContextInterceptor` (wraps the handler)

For an authenticated route it opens `withTenant(db, tenantId, …)` (`@fde/db`) —
`SET LOCAL ROLE app_rw` + `app.tenant_id`, so Postgres RLS scopes every query —
around the handler. For a route marked `@EngagementScope('<param>')` it opens
`withEngagement(db, keyProvider, { tenantId, engagementId }, …)` instead: the
tenant transaction **plus** one KMS unwrap of the engagement DEK, giving the
handler an `EngagementCipher` for 🔒 columns.

`next.handle()` is subscribed _inside_ the transaction callback (via
`lastValueFrom`), so the whole handler — and everything it awaits — runs within
the open transaction and commits when it resolves. A missing engagement → 404, a
crypto-shredded one → 410.

### 3. `RequestContext` (`AsyncLocalStorage`)

The interceptor calls `runWithRequestContext({ tenantId, userId, tx, engagement? }, …)`.
Handlers reach it through:

| helper                   | returns                                    |
| ------------------------ | ------------------------------------------ |
| `getRequestContext()`    | `{ tenantId, userId, tx, engagement? }`    |
| `getTx()`                | the open, RLS-scoped `DbTransaction`       |
| `getEngagementContext()` | `{ id, cipher }` (throws off an eng route) |

**Handlers never call `createDbClient` / `withTenant` / `withEngagement`
themselves.** This mirrors, on the request side, the explicit-`cipher`-param
convention `@fde/workers` uses across the Temporal boundary
(`apps/workers/src/activities/engagement-context.ts`) — same crypto-context
shape, different propagation mechanism (ALS here, an explicit argument there,
because Temporal has no shared async chain).

The `KeyProvider` is a DI provider (`key-provider/`): real `KmsKeyProvider` from
`AWS_REGION`, `FakeKeyProvider` when `FDE_FAKE_KMS=true` (refused under
`NODE_ENV=production` by the env schema).

## WorkOS (SSO + SCIM)

Everything WorkOS goes through the `WorkOsPort` interface (`auth/workos.types.ts`).
`WorkOsService` implements it against `@workos-inc/node`; `FakeWorkOsService`
implements it in memory. `AuthModule` binds the live one **only when
`WORKOS_API_KEY` is set** — otherwise the whole flow (login → callback →
session, and the webhook receiver) runs on the fake, no WorkOS account needed.

- `GET /auth/login` → redirect to WorkOS AuthKit; a random `state` nonce is sent
  to WorkOS and stored in a short-lived `fde_oauth_state` cookie.
- `GET /auth/callback?code=…&state=…` → verify `state` against the cookie
  (CSRF), exchange the code, map WorkOS org → tenant (`WORKOS_ORG_TENANT_MAP`,
  values validated as UUIDs), **upsert the `users` row** (on `workos_user_id`,
  then `INSERT … ON CONFLICT (tenant_id, email)`), and set the session as an
  httpOnly cookie (`secure` under `NODE_ENV=production`). The token is **not** in
  the response body — read it from `Set-Cookie`. A WorkOS org with no tenant
  mapping → 401.
- `POST /webhooks/workos` → verify the signature over the raw body against
  `WORKOS_WEBHOOK_SECRET` (**before** anything else), then apply Directory-Sync
  events. `dsync.user.deleted` / `dsync.user.deactivated` set `users.status =
'disabled'` and **revoke every live session** for that WorkOS user
  immediately.

Session storage is in-memory (skeleton) — a real deployment moves `SessionService`
to Redis. The store is keyed by `sha256(token)`, not the raw token. Webhook
signature verification enforces a 5-minute timestamp window (replay protection)
on both the live and fake adapters.

## Routes

| Route                        | Scope      | Notes                                                      |
| ---------------------------- | ---------- | ---------------------------------------------------------- |
| `GET /healthz`               | public     | liveness, no DB                                            |
| `GET /me`                    | tenant     | the caller's `users` row via the request tx                |
| `GET /engagements`           | tenant     | RLS-scoped list, newest first                              |
| `GET /engagements/:id/audit` | engagement | `@fde/audit` `listAccess`; logs its own `content_read` row |

## Config

`@nestjs/config` + a zod schema (`config/env.ts`), validated at
module-evaluation time — the process refuses to start on a missing/invalid var.
`NODE_ENV=production` additionally requires the WorkOS credentials and forbids
`FDE_FAKE_KMS=true`. See `.env.example` at the repo root.

## OpenAPI

`@nestjs/swagger` builds the document from route metadata; `/docs` serves the UI,
and `pnpm --filter @fde/api openapi` writes `apps/api/openapi.json` for a
generated client to consume later. Regenerate it when routes or DTOs change.

## Tests

```bash
pnpm --filter @fde/api test
```

- `request-context/tenant-context.guard.test.ts` — the guard resolves context /
  rejects unauthenticated + revoked sessions.
- `request-context/tenant-context.interceptor.test.ts` — the interceptor opens
  `withTenant` / `withEngagement` and hands the tx + a live cipher to the
  handler (fake DB, `FakeKeyProvider` — no Postgres).
- `config/env.test.ts`, `auth/fake-workos.service.test.ts` — unit.
- `app.e2e.test.ts` — supertest against the real app with a stub DB: `/healthz`,
  401-before-DB on the tenant routes, WorkOS webhook signature verification,
  login redirect.
- `seam.integration.test.ts` — `describe.skipIf(!DATABASE_URL)`, against a
  migrated + hardened database (same setup as `packages/db`): SSO callback →
  `/me`, RLS-scoped `/engagements`, the self-logging audit route, tenant A
  cannot see tenant B's engagement or audit rows through the HTTP layer, and
  SCIM deprovision kills the session.
  ```bash
  docker compose up -d postgres && <bootstrap + migrate + harden, see packages/db/README.md>
  DATABASE_URL=postgres://postgres:postgres@localhost:5433/fde_dev pnpm --filter @fde/api test
  ```
