import { FakeGranolaClient } from './fake-granola-client.js';
import { type GranolaClient } from './granola-client.js';
import { DEFAULT_GRANOLA_BASE_URL, HttpGranolaClient } from './http-granola-client.js';

/**
 * Client selection: the real `HttpGranolaClient` when `GRANOLA_API_KEY` is set,
 * the deterministic `FakeGranolaClient` otherwise — so local dev and CI run the
 * connector + `ConnectorSync` workflow end to end without a Granola account, and
 * production is a config flip. A missing key in production is a
 * misconfiguration, not a silent fallback to a fake.
 */
export function loadGranolaClient(env: NodeJS.ProcessEnv): GranolaClient {
  if (env.GRANOLA_API_KEY) {
    return new HttpGranolaClient({
      apiKey: env.GRANOLA_API_KEY,
      baseUrl: env.GRANOLA_API_BASE_URL ?? DEFAULT_GRANOLA_BASE_URL,
    });
  }
  if (env.NODE_ENV === 'production') {
    throw new Error('GRANOLA_API_KEY is required when NODE_ENV=production');
  }
  return new FakeGranolaClient();
}
