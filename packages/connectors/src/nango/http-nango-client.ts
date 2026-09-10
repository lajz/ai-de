import {
  DEFAULT_NANGO_SERVER_URL,
  NangoApiError,
  type NangoClient,
  type NangoConnection,
} from './nango-client.js';

export interface HttpNangoClientOptions {
  /** Nango environment/account secret key — the `Authorization: Bearer` value */
  secretKey: string;
  /** self-hosted Nango server URL, no trailing slash (default `DEFAULT_NANGO_SERVER_URL`) */
  serverUrl?: string;
  /** injectable for tests; defaults to global `fetch` */
  fetchImpl?: typeof fetch;
}

// --- Nango wire shapes (kept private to this module) ---------------------------

interface ConnectionResponse {
  metadata?: Record<string, unknown> | null;
  credentials?: {
    access_token?: string | null;
    /** OAuth2 bearer alias some providers use */
    token?: string | null;
    expires_at?: string | null;
  } | null;
}

function coerceMetadata(raw: Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (typeof v === 'string') out[k] = v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
  }
  return out;
}

/**
 * Real Nango client — REST against a self-hosted `NANGO_SERVER_URL` with
 * `NANGO_SECRET_KEY`. `refresh_token=false`; `force_refresh` is left to Nango's
 * own just-in-time expiry check (it refreshes when the stored token is near
 * expiry). Untested against a live server until `NANGO_SECRET_KEY` lands —
 * exercised only by `nango-client.smoke.test.ts`. Everything above `NangoClient`
 * runs on `FakeNangoClient`.
 */
export class HttpNangoClient implements NangoClient {
  private readonly secretKey: string;
  private readonly serverUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpNangoClientOptions) {
    if (!options.secretKey) throw new Error('HttpNangoClient: secretKey is required');
    this.secretKey = options.secretKey;
    this.serverUrl = (options.serverUrl ?? DEFAULT_NANGO_SERVER_URL).replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getConnection(connectionId: string, providerConfigKey: string): Promise<NangoConnection> {
    const q = new URLSearchParams({
      provider_config_key: providerConfigKey,
      refresh_token: 'false',
    });
    const path = `/connection/${encodeURIComponent(connectionId)}?${q.toString()}`;
    const res = await this.fetchImpl(`${this.serverUrl}${path}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${this.secretKey}`, accept: 'application/json' },
    });
    if (!res.ok) {
      // Nango error bodies are small JSON — safe to surface (no token material).
      const detail = await res.text().catch(() => '');
      throw new NangoApiError(
        res.status,
        'GET',
        `/connection/${connectionId}`,
        detail.slice(0, 500),
      );
    }
    const body = (await res.json()) as ConnectionResponse;
    const accessToken = body.credentials?.access_token ?? body.credentials?.token ?? '';
    if (!accessToken) {
      throw new NangoApiError(
        res.status,
        'GET',
        `/connection/${connectionId}`,
        'response carried no access token',
      );
    }
    return {
      accessToken,
      ...(body.credentials?.expires_at ? { expiresAt: body.credentials.expires_at } : {}),
      metadata: coerceMetadata(body.metadata),
    };
  }
}
