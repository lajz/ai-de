import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import type { AuthzClient } from './client.js';
import { InMemoryInProductionError } from './errors.js';
import { InMemoryAuthzClient } from './in-memory.js';
import { SpiceDbAuthzClient } from './spicedb.js';

/**
 * Load the repo-root `.env` into `process.env` (keys not already set) — the same
 * local-dev/CI convenience `@fde/llm`'s `loadLlmEnv` provides. No-ops under
 * `NODE_ENV=production` (a deployed process takes its environment only from what
 * the platform injects) and when the file is genuinely absent. In Orca worktrees
 * `.env` is a symlink onto a shared volume that can momentarily EIO, so a
 * transient read is retried a few times.
 */
export function loadAuthzEnv(root = repoRoot()): void {
  if (process.env.NODE_ENV === 'production' || !root) return;
  const path = join(root, '.env');
  for (let i = 0; i < 4; i++) {
    try {
      process.loadEnvFile(path); // Node >=20.12; only sets keys not already present
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      if (i === 3) {
        console.warn(`@fde/authz: could not read ${path}: ${(err as Error).message}`);
        return;
      }
    }
  }
}

function repoRoot(): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/**
 * Build the `AuthzClient` from the environment:
 *
 * - `SPICEDB_ENDPOINT` **and** `SPICEDB_TOKEN` set → `SpiceDbAuthzClient`
 *   (`SPICEDB_INSECURE=true` for a local plaintext `spicedb serve --grpc-no-tls`).
 * - otherwise → `InMemoryAuthzClient`, with a one-line stderr warning —
 *   **unless** `NODE_ENV=production`, where that throws instead.
 */
export function createAuthzClientFromEnv(env: NodeJS.ProcessEnv = process.env): AuthzClient {
  if (env === process.env) loadAuthzEnv();

  const endpoint = env.SPICEDB_ENDPOINT;
  const token = env.SPICEDB_TOKEN;
  if (endpoint && token) {
    return new SpiceDbAuthzClient({ endpoint, token, insecure: env.SPICEDB_INSECURE === 'true' });
  }

  if (env.NODE_ENV === 'production') throw new InMemoryInProductionError();

  console.warn(
    '@fde/authz: SPICEDB_ENDPOINT/SPICEDB_TOKEN unset — using InMemoryAuthzClient (dev/test only)',
  );
  return new InMemoryAuthzClient();
}
