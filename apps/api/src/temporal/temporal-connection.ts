import type { ConnectionOptions } from '@temporalio/client';

import type { Env } from '../config/env.js';

/**
 * Client-side Temporal connection config, resolved from the validated env.
 *
 * This is the ~10-line client half of `apps/workers/src/connection.ts`
 * (`loadTemporalConnectionConfig`) — duplicated rather than imported because
 * `@fde/workers` exposes no package entry point and its `connection.ts` pulls in
 * `@temporalio/worker` (native `NativeConnection`), which `apps/api` must not
 * depend on. Keep the auth rules here in sync with that file.
 *
 * Returns `null` when Temporal is not configured (`TEMPORAL_ADDRESS` unset) — the
 * API then binds a `null` workflow client and the sync endpoint returns 503.
 */
export interface TemporalClientConfig {
  address: string;
  namespace: string;
  connection: ConnectionOptions;
}

export function loadTemporalClientConfig(env: Env): TemporalClientConfig | null {
  const address = env.TEMPORAL_ADDRESS;
  if (!address) return null;

  const namespace = env.TEMPORAL_NAMESPACE ?? 'default';
  const cert = env.TEMPORAL_CLIENT_CERT;
  const key = env.TEMPORAL_CLIENT_KEY;
  const apiKey = env.TEMPORAL_API_KEY;

  if ((cert && !key) || (!cert && key)) {
    throw new Error(
      'Temporal mTLS is half-configured: TEMPORAL_CLIENT_CERT and TEMPORAL_CLIENT_KEY must both be set (or neither).',
    );
  }
  if (cert && key && apiKey) {
    throw new Error(
      'Temporal connection has both mTLS (TEMPORAL_CLIENT_CERT/KEY) and TEMPORAL_API_KEY set — pick one auth method.',
    );
  }

  if (cert && key) {
    return {
      address,
      namespace,
      connection: {
        address,
        tls: { clientCertPair: { crt: Buffer.from(cert), key: Buffer.from(key) } },
      },
    };
  }
  if (apiKey) {
    return { address, namespace, connection: { address, tls: true, apiKey } };
  }
  return { address, namespace, connection: { address } };
}
