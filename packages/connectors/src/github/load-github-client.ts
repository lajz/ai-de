import { FakeGitHubClient } from './fake-github-client.js';
import { DEFAULT_GITHUB_API_URL, type GitHubClient } from './github-client.js';
import { HttpGitHubClient } from './http-github-client.js';

/** Builds a `GitHubClient` bound to one Nango-minted OAuth access token + repo. */
export type GitHubClientFactory = (accessToken: string, repoFullName: string) => GitHubClient;

/**
 * Client selection, mirroring `loadLinearClientFactory`: the real
 * `HttpGitHubClient` when a self-hosted Nango is configured
 * (`NANGO_SECRET_KEY` set), the deterministic `FakeGitHubClient` otherwise —
 * so local dev and CI run the connector + `ConnectorSync` workflow end to end
 * without a Nango server or a GitHub App. GitHub is Nango-only (no direct API
 * key), so it tracks the Nango config flip. A missing key in production is a
 * misconfiguration.
 */
export function loadGitHubClientFactory(env: NodeJS.ProcessEnv): GitHubClientFactory {
  if (env.NANGO_SECRET_KEY) {
    return (accessToken: string, repoFullName: string) =>
      new HttpGitHubClient({
        accessToken,
        repoFullName,
        apiUrl: env.GITHUB_API_URL ?? DEFAULT_GITHUB_API_URL,
      });
  }
  if (env.NODE_ENV === 'production') {
    throw new Error('NANGO_SECRET_KEY is required when NODE_ENV=production (GitHub runs on Nango)');
  }
  return (_accessToken: string, repoFullName: string) => new FakeGitHubClient({ repoFullName });
}
