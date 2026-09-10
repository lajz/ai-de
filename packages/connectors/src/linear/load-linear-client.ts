import { FakeLinearClient } from './fake-linear-client.js';
import { DEFAULT_LINEAR_API_URL, type LinearClient } from './linear-client.js';
import { HttpLinearClient } from './http-linear-client.js';

/** Builds a `LinearClient` bound to one Nango-minted OAuth access token. */
export type LinearClientFactory = (accessToken: string) => LinearClient;

/**
 * Client selection, mirroring `loadGranolaClient` / `loadNangoClient`: the real
 * `HttpLinearClient` when a self-hosted Nango is configured (`NANGO_SECRET_KEY`
 * set), the deterministic `FakeLinearClient` otherwise — so local dev and CI run
 * the connector + `ConnectorSync` workflow end to end without a Nango server or
 * a Linear workspace. Linear is Nango-only (no direct API key), so it tracks the
 * Nango config flip. A missing key in production is a misconfiguration.
 */
export function loadLinearClientFactory(env: NodeJS.ProcessEnv): LinearClientFactory {
  if (env.NANGO_SECRET_KEY) {
    return (accessToken: string) =>
      new HttpLinearClient({
        accessToken,
        apiUrl: env.LINEAR_API_URL ?? DEFAULT_LINEAR_API_URL,
      });
  }
  if (env.NODE_ENV === 'production') {
    throw new Error('NANGO_SECRET_KEY is required when NODE_ENV=production (Linear runs on Nango)');
  }
  return () => new FakeLinearClient();
}
