# Self-hosted Nango — OAuth token custody

Every `authKind: 'nango-oauth'` connector (Linear for M3; Google Docs, Jira, …
later) gets its access token from a **self-hosted Nango**, never from a token
this platform stores. `docs/architecture.md` ("Connector Strategy",
"Sub-processor posture"): Nango self-hosted, not Nango Cloud — connector tokens
are crown-jewel access and stay inside the data plane. Nango owns the OAuth
dance, encrypted token storage, and refresh; `@fde/connectors` only ever asks
for a fresh access token just before it makes a call.

## Where it fits

```
connector_config.credentialRef  ──(engagement DEK)──►  a Nango connection id
        │
        ▼  (apps/workers ConnectorSync activity, makeGetCredential)
NangoClient.getConnection(connectionId, providerConfigKey='linear')
        │
        ▼
{ accessToken, expiresAt?, metadata }  ──►  ConnectorContext.getCredential()
        │
        ▼
HttpLinearClient({ accessToken })  ──►  Linear GraphQL
```

- **`NangoClient`** (`nango-client.ts`) — the seam. `HttpNangoClient` speaks
  Nango's REST API (`GET /connection/:id?provider_config_key=…`, bearer =
  `NANGO_SECRET_KEY`); `FakeNangoClient` returns a canned token so the connector
  and the sync workflow run without a Nango server. `loadNangoClient(env)` picks
  one on `NANGO_SECRET_KEY`.
- **`providerConfigKey`** is the connector id by convention (`'linear'` → the
  `linear` integration in Nango).
- `connector_config.credentialRef` holds the **Nango connection id** as an
  encrypted string. The admin `PUT /engagements/:id/connectors/linear` endpoint
  writes it; today you paste the connection id directly (the real Nango Connect
  UI "connect" flow is a follow-up).

## One-time local setup

1. Start Nango: `tilt up -- nango` (or `docker compose --profile nango up -d`).
   Server on `http://localhost:3003`, Connect UI on `:3009`. `FLAG_AUTH_ENABLED`
   is off for local dev — the default environment's secret key is
   `NANGO_SECRET_KEY` (compose default `nango-dev-secret-key`).
2. Create a **Linear OAuth app**
   (<https://linear.app/settings/api/applications/new>): redirect URL
   `http://localhost:3003/oauth/callback`, scopes `read` (plus `write` later for
   the write-back follow-up). Note the client id + secret.
3. In the Nango dashboard (`http://localhost:3003`) → **Integrations** → add
   **Linear**, set **Unique Key** (providerConfigKey) to `linear`, and paste the
   Linear client id + secret.
4. Create a connection for the engagement: run the Connect flow from the Nango
   dashboard (or the hosted Connect UI) and authorize against the target Linear
   workspace. Copy the resulting **connection id**.
5. Attach it to the engagement: `PUT /engagements/:id/connectors/linear` with
   `{ "enabled": true, "credential": "<connection id>" }`, then
   `POST /engagements/:id/connectors/linear/sync` with `{ "mode": "backfill" }`.

## Production

`NANGO_SECRET_KEY` + `NANGO_SERVER_URL` are **required** when
`NODE_ENV=production` (`loadNangoClient` / `loadLinearClientFactory` throw
otherwise — no silent fallback to a fake). Run Nango in-VPC with its own
Postgres; back it up and rotate `NANGO_ENCRYPTION_KEY` per your key policy.

## Webhooks

`LinearConnector.handleWebhook` verifies the `linear-signature` header (HMAC-256
over the raw body) against `LINEAR_WEBHOOK_SECRET`. Point the Linear webhook at
the platform's own receiver with that secret. Alternatively Nango can proxy +
verify provider webhooks and forward a normalized event — if you go that route,
the receiver trusts Nango's signature instead and `LINEAR_WEBHOOK_SECRET` is
unused. M3 ships the direct path; the Nango-proxy path is a config choice.

## GitHub

Same Nango custody model as Linear, one `authKind: 'nango-oauth'` connector
alongside it — `providerConfigKey` = `github`. Two differences from Linear are
worth calling out up front:

- **Repo scope, not workspace scope.** A GitHub connection is bound to exactly
  one repo (`connector_config.externalScopeRef` holds `owner/repo` — the same
  column, the same partial-unique-index security property the webhook receiver
  already relies on for Linear). `GitHubConnector` itself never reads
  `connector_config` directly (`LinearConnector` doesn't either); instead it
  reads the bound repo off **`NangoConnection.metadata.repo`** — set that key
  on the connection at connect time (Nango's Connect flow, or the dashboard,
  lets you attach arbitrary connection metadata). This is the same metadata
  channel Nango already exposes for exactly this ("workspace id, region, …" per
  the `NangoConnection` doc comment above) — no schema change, no change to
  `ConnectorContext`, `apps/workers/.../connector-sync.ts`, or
  `WebhookLandingService` was needed to add GitHub.
- **A GitHub App, not a plain OAuth App, is the recommended integration type.**
  A GitHub App can be installed on a specific repo (or a chosen subset of an
  org's repos) with fine-grained, read-only permissions (`pull_requests: read`,
  `metadata: read`, plus `members: read` if you want collaborator-list ACL
  resolution) — a materially better fit for "one engagement, one repo" than an
  OAuth App, which authorizes as a _user_ against everything that user can see.
  Nango supports both integration types identically from this package's point
  of view (`HttpGitHubClient` only ever sees a bearer token); nothing here is
  GitHub-App-specific except the setup step below.

### One-time local setup

1. Start Nango (same as the Linear setup above).
2. Create a **GitHub App** (<https://github.com/settings/apps/new>): webhook
   URL can point anywhere for now (v1 does not use Nango-proxied GitHub
   webhooks — see below), permissions **Repository → Pull requests: Read-only**
   and **Repository → Metadata: Read-only** (add **Members: Read-only** on the
   org if you want ACL collaborator resolution), and install it on the target
   repo. Note the App id, client id/secret, and private key.
3. In the Nango dashboard → **Integrations** → add **GitHub App**, set
   **Unique Key** (`providerConfigKey`) to `github`, and paste the App
   credentials.
4. Create a connection for the engagement: run the Connect flow (or the
   dashboard) against the target installation, **then set that connection's
   metadata to `{"repo": "owner/repo"}`** — the one manual step this connector
   needs beyond what Linear's setup already does. Copy the resulting
   **connection id**.
5. Attach it to the engagement: `PUT /engagements/:id/connectors/github` with
   `{ "enabled": true, "credential": "<connection id>", "externalScopeRef": "owner/repo" }`
   — the same generic `PUT` Linear uses; `externalScopeRef` is what the webhook
   receiver looks up by (see `packages/db/src/schema/connector-config.ts`), and
   should match the `repo` you set on the connection's metadata in step 4. Then
   `POST /engagements/:id/connectors/github/sync` with `{ "mode": "backfill" }`.

### Webhooks

`GitHubConnector.handleWebhook` verifies the `x-hub-signature-256` header
(`sha256=<hex>`, HMAC-256 over the raw body) against `GITHUB_WEBHOOK_SECRET` —
GitHub's actual scheme, different from Linear's raw-hex `linear-signature`.
Point the repo's webhook (or the GitHub App's webhook, if delivering at the App
level) at the platform's own receiver (`webhooks/github`) with that secret, and
subscribe to the **Pull requests** event. As with Linear, Nango can
alternatively proxy + verify provider webhooks; v1 ships the direct path.
