import { FakeNangoClient } from './fake-nango-client.js';
import { DEFAULT_NANGO_SERVER_URL, type NangoClient } from './nango-client.js';
import { HttpNangoClient } from './http-nango-client.js';

/**
 * Client selection: the real `HttpNangoClient` when `NANGO_SECRET_KEY` is set,
 * the deterministic `FakeNangoClient` otherwise — so local dev and CI run every
 * `nango-oauth` connector + the `ConnectorSync` workflow end to end without a
 * Nango server, and production is a config flip. A missing key in production is
 * a misconfiguration, not a silent fallback to a fake (`docs/architecture.md`:
 * Nango self-hosted is mandatory for token custody).
 */
export function loadNangoClient(env: NodeJS.ProcessEnv): NangoClient {
  if (env.NANGO_SECRET_KEY) {
    return new HttpNangoClient({
      secretKey: env.NANGO_SECRET_KEY,
      serverUrl: env.NANGO_SERVER_URL ?? DEFAULT_NANGO_SERVER_URL,
    });
  }
  if (env.NODE_ENV === 'production') {
    throw new Error('NANGO_SECRET_KEY is required when NODE_ENV=production');
  }
  return new FakeNangoClient();
}
