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
