import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { GranolaApiError } from './granola-client.js';
import { HttpGranolaClient } from './http-granola-client.js';

// Load the worktree-local .env (gitignored, per-worktree) the way the Recall
// smoke test does — so `GRANOLA_API_KEY=…` there enables this suite.
try {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  process.loadEnvFile(join(root, '.env'));
} catch {
  // no .env / not a git checkout — the skipIf below handles it
}

const apiKey = process.env.GRANOLA_API_KEY;

/**
 * Live Granola smoke test — the ONLY thing that touches the real API. All the
 * connector logic + encryption + retention handling runs against
 * `FakeGranolaClient` and is complete without an account; this just confirms
 * `HttpGranolaClient` speaks the wire protocol once a key lands.
 */
describe.skipIf(!apiKey)('HttpGranolaClient (live)', () => {
  const client = () =>
    new HttpGranolaClient({
      apiKey: apiKey!,
      ...(process.env.GRANOLA_API_BASE_URL ? { baseUrl: process.env.GRANOLA_API_BASE_URL } : {}),
    });

  it('authenticates and lists workspaces', async () => {
    const workspaces = await client().listWorkspaces();
    expect(Array.isArray(workspaces)).toBe(true);
  });

  it('404s an unknown document without an auth error', async () => {
    const err = await client()
      .getTranscript('00000000-0000-0000-0000-000000000000')
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GranolaApiError);
    // 404 = auth worked, doc just doesn't exist. 401/403 = the key is bad.
    expect((err as GranolaApiError).status).toBe(404);
  });
});
