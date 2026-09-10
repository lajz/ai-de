import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { HttpLinearClient } from './http-linear-client.js';

// Load the worktree-local .env the way the Granola smoke test does — so
// LINEAR_SMOKE_TOKEN there enables this suite. In production the token comes
// from Nango, never from env; this is a wire-protocol check only.
try {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  process.loadEnvFile(join(root, '.env'));
} catch {
  // no .env / not a git checkout — the skipIf below handles it
}

const token = process.env.LINEAR_SMOKE_TOKEN;

/**
 * Live Linear smoke test — the ONLY thing that touches the real GraphQL API.
 * All the connector logic + normalization + retention handling runs against
 * `FakeLinearClient`; this just confirms `HttpLinearClient` speaks the wire
 * protocol given a valid OAuth/personal token.
 */
describe.skipIf(!token)('HttpLinearClient (live)', () => {
  const client = () =>
    new HttpLinearClient({
      accessToken: token!,
      ...(process.env.LINEAR_API_URL ? { apiUrl: process.env.LINEAR_API_URL } : {}),
    });

  it('authenticates and reads the workspace', async () => {
    const ws = await client().listWorkspace();
    expect(typeof ws.id).toBe('string');
    expect(ws.id.length).toBeGreaterThan(0);
  });

  it('lists a page of issues', async () => {
    const page = await client().listIssues({ limit: 1 });
    expect(Array.isArray(page.items)).toBe(true);
  });
});
