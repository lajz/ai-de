import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { HttpGitHubClient } from './http-github-client.js';

// Load the worktree-local .env the way the Linear smoke test does — so
// GITHUB_SMOKE_TOKEN + GITHUB_SMOKE_REPO there enable this suite. In
// production the token comes from Nango, never from env; this is a
// wire-protocol check only.
try {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  process.loadEnvFile(join(root, '.env'));
} catch {
  // no .env / not a git checkout — the skipIf below handles it
}

const token = process.env.GITHUB_SMOKE_TOKEN;
const repoFullName = process.env.GITHUB_SMOKE_REPO;

/**
 * Live GitHub smoke test — the ONLY thing that touches the real REST API. All
 * the connector logic + normalization + retention handling runs against
 * `FakeGitHubClient`; this just confirms `HttpGitHubClient` speaks the wire
 * protocol given a valid token and a real repo it can read.
 */
describe.skipIf(!token || !repoFullName)('HttpGitHubClient (live)', () => {
  const client = () =>
    new HttpGitHubClient({
      accessToken: token!,
      repoFullName: repoFullName!,
      ...(process.env.GITHUB_API_URL ? { apiUrl: process.env.GITHUB_API_URL } : {}),
    });

  it('authenticates and reads the repo', async () => {
    const repo = await client().listRepository();
    expect(repo.fullName.toLowerCase()).toBe(repoFullName!.toLowerCase());
  });

  it('lists a page of pull requests', async () => {
    const page = await client().listPullRequests({ limit: 1 });
    expect(Array.isArray(page.items)).toBe(true);
  });
});
