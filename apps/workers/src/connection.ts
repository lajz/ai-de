import { Connection } from '@temporalio/client';
import type { TLSConfig } from '@temporalio/client';
import { NativeConnection } from '@temporalio/worker';

/**
 * Temporal connection config, resolved from the environment. Two supported
 * shapes:
 *
 *  - **Temporal Cloud** (T0 default): `TEMPORAL_ADDRESS` + `TEMPORAL_NAMESPACE`,
 *    plus either mTLS (`TEMPORAL_CLIENT_CERT` + `TEMPORAL_CLIENT_KEY`, PEM) or an
 *    API key (`TEMPORAL_API_KEY`).
 *  - **Local dev**: nothing set, or `TEMPORAL_ADDRESS` pointing at localhost —
 *    `temporal server start-dev` (default `localhost:7233`), no TLS.
 *
 * A non-local address with no credentials, or a half-supplied credential pair,
 * fails fast at startup rather than producing a confusing connect-time error.
 */

export interface TemporalConnectionConfig {
  address: string;
  namespace: string;
  /** `true` for API-key auth (TLS with no client cert), a cert pair for mTLS, or absent for local dev. */
  tls?: TLSConfig | true;
  apiKey?: string;
}

const LOCALHOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

export function loadTemporalConnectionConfig(
  env: NodeJS.ProcessEnv = process.env,
): TemporalConnectionConfig {
  const address = env.TEMPORAL_ADDRESS ?? 'localhost:7233';
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
      tls: { clientCertPair: { crt: Buffer.from(cert), key: Buffer.from(key) } },
    };
  }
  if (apiKey) {
    return { address, namespace, tls: true, apiKey };
  }
  if (LOCALHOST_RE.test(address)) {
    return { address, namespace };
  }
  throw new Error(
    `TEMPORAL_ADDRESS=${address} is not localhost, but neither mTLS (TEMPORAL_CLIENT_CERT/TEMPORAL_CLIENT_KEY) nor TEMPORAL_API_KEY is set. Temporal Cloud requires one of them.`,
  );
}

/** Client connection — for starting/signalling/querying workflows (e.g. from `apps/api`). */
export function connectClient(config: TemporalConnectionConfig): Promise<Connection> {
  return Connection.connect({ address: config.address, tls: config.tls, apiKey: config.apiKey });
}

/** Worker connection — pass to `Worker.create({ connection, ... })`. */
export function connectWorkerConnection(
  config: TemporalConnectionConfig,
): Promise<NativeConnection> {
  return NativeConnection.connect({
    address: config.address,
    tls: config.tls,
    apiKey: config.apiKey,
  });
}
