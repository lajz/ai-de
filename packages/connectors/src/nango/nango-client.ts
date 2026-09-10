/**
 * The seam over a **self-hosted Nango** (https://nango.dev) — the mandated OAuth
 * custody layer for every `authKind: 'nango-oauth'` connector (Linear for M3,
 * Google Docs / Jira / … later). `docs/architecture.md` ("Connector Strategy",
 * "Sub-processor posture"): Nango self-hosted, never Nango Cloud — connector
 * tokens are crown-jewel access and must stay inside the data plane.
 *
 * Nango owns the OAuth dance, token storage, and **refresh** — the platform
 * never sees a refresh token or a client secret. It calls `getConnection` right
 * before each use and gets back a fresh access token (Nango refreshes
 * server-side when the stored one is close to expiry).
 *
 * `HttpNangoClient` speaks Nango's REST API; `FakeNangoClient` is a
 * deterministic in-memory stand-in so the connector + `ConnectorSync` workflow
 * run end to end without a Nango server. Selection is a config flip on
 * `NANGO_SECRET_KEY` — see `loadNangoClient`.
 */

/** A connection's live credentials, as this package needs them. */
export interface NangoConnection {
  /** a fresh OAuth access token — Nango refreshed it server-side if needed */
  accessToken: string;
  /** ISO-8601 expiry of `accessToken`, when Nango reports one */
  expiresAt?: string;
  /** connection metadata set at connect time (workspace id, region, …) — never a secret */
  metadata: Record<string, string>;
}

export interface NangoClient {
  /**
   * The current credentials for one connection.
   *
   * @param connectionId       the Nango connection id (what `connector_config.credentialRef` holds)
   * @param providerConfigKey  the Nango integration id — the connector id by convention (`'linear'`)
   */
  getConnection(connectionId: string, providerConfigKey: string): Promise<NangoConnection>;
}

/** Raised by `HttpNangoClient` for a non-2xx Nango response. Carries no token material. */
export class NangoApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly detail: string,
  ) {
    super(`Nango API ${method} ${path} → ${status}${detail ? `: ${detail}` : ''}`);
    this.name = 'NangoApiError';
  }
}

/** Default self-hosted Nango server URL (`docker-compose.yml`, `nango` profile). */
export const DEFAULT_NANGO_SERVER_URL = 'http://localhost:3003';
