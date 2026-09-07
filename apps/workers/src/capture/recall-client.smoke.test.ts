import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { HttpRecallClient } from './http-recall-client.js';
import { RecallApiError } from './recall-client.js';

// Load the worktree-local .env (gitignored, per-worktree) the way
// tools/review/src/config.ts does — so `RECALL_API_KEY=...` there enables this
// suite. `process.loadEnvFile` only sets keys not already present.
try {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  process.loadEnvFile(join(root, '.env'));
} catch {
  // no .env / not a git checkout — the skipIf below handles it
}

const apiKey = process.env.RECALL_API_KEY;

/**
 * Live Recall.ai smoke test — the ONLY thing that touches the real API. All the
 * capture workflow logic + encryption + retention handling is exercised against
 * `FakeRecallClient` and is complete without an account; this just confirms
 * `HttpRecallClient` speaks the wire protocol once a key lands.
 */
describe.skipIf(!apiKey)('HttpRecallClient (live)', () => {
  // built inside the test, not the describe body: a skipped `describe` still
  // runs its synchronous body during collection, and `new HttpRecallClient`
  // throws without a key.
  const client = () =>
    new HttpRecallClient({
      apiKey: apiKey!,
      ...(process.env.RECALL_API_BASE_URL ? { baseUrl: process.env.RECALL_API_BASE_URL } : {}),
    });

  it('authenticates and 404s a non-existent bot id', async () => {
    const err = await client()
      .getBot('00000000-0000-0000-0000-000000000000')
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RecallApiError);
    // 404 = auth worked, bot just doesn't exist. 401/403 = the key is bad.
    expect((err as RecallApiError).status).toBe(404);
  });
});
