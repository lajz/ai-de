/**
 * `pnpm --filter @fde/authz schema:push` — push `AUTHZ_SCHEMA` to the configured
 * SpiceDB. Reads the same env as the app (`SPICEDB_ENDPOINT`, `SPICEDB_TOKEN`,
 * `SPICEDB_INSECURE`); see the package README for running SpiceDB locally.
 *
 * Running it with no SpiceDB configured pushes to a throwaway in-memory client
 * (a no-op) — and refuses outright under `NODE_ENV=production`.
 */
import { createAuthzClientFromEnv } from './env.js';
import { AUTHZ_SCHEMA, SCHEMA_VERSION } from './schema.js';

const target = process.env.SPICEDB_ENDPOINT ?? '(in-memory — no SPICEDB_ENDPOINT set)';
const client = createAuthzClientFromEnv();
await client.writeSchema(AUTHZ_SCHEMA);
console.error(`@fde/authz: pushed schema ${SCHEMA_VERSION} to ${target}`);
