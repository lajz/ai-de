import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { NangoApiError } from './nango-client.js';
import { HttpNangoClient } from './http-nango-client.js';

// Load the worktree-local .env the way the Granola smoke test does — so
// NANGO_SECRET_KEY + NANGO_SERVER_URL there enable this suite.
try {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  process.loadEnvFile(join(root, '.env'));
} catch {
  // no .env / not a git checkout — the skipIf below handles it
}

const secretKey = process.env.NANGO_SECRET_KEY;

/**
 * Live Nango smoke test — the ONLY thing that touches a real Nango server. All
 * the credential-provider logic runs against `FakeNangoClient`; this just
 * confirms `HttpNangoClient` speaks the REST protocol once a self-hosted Nango
 * is up (`docker compose --profile nango up` / `tilt up -- nango`).
 */
describe.skipIf(!secretKey)('HttpNangoClient (live)', () => {
  const client = () =>
    new HttpNangoClient({
      secretKey: secretKey!,
      ...(process.env.NANGO_SERVER_URL ? { serverUrl: process.env.NANGO_SERVER_URL } : {}),
    });

  it('rejects an unknown connection without an auth error', async () => {
    const err = await client()
      .getConnection('00000000-0000-0000-0000-000000000000', 'linear')
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NangoApiError);
    // 404 = auth worked, connection just doesn't exist. 401/403 = the key is bad.
    expect((err as NangoApiError).status).toBe(404);
  });
});
