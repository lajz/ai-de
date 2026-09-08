import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthzClient, createAuthzClientFromEnv } from '@fde/authz';

import type { Env } from '../config/env.js';

/**
 * The `@fde/authz` seam. `createAuthzClientFromEnv` picks `SpiceDbAuthzClient`
 * when `SPICEDB_ENDPOINT` + `SPICEDB_TOKEN` are set and the in-memory client
 * otherwise (refused under `NODE_ENV=production` — see `config/env.ts`). The
 * env is handed over from the validated `ConfigService`, not read ambiently.
 *
 * `@Global` so `EngagementsController` and `AuthService` can inject
 * `AuthzClient` without re-importing. Tests bind `InMemoryAuthzClient` directly
 * (`overrideProvider(AuthzClient)` in the test harness).
 */
@Global()
@Module({
  providers: [
    {
      provide: AuthzClient,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): AuthzClient =>
        createAuthzClientFromEnv({
          NODE_ENV: config.get('NODE_ENV', { infer: true }),
          SPICEDB_ENDPOINT: config.get('SPICEDB_ENDPOINT', { infer: true }),
          SPICEDB_TOKEN: config.get('SPICEDB_TOKEN', { infer: true }),
          SPICEDB_INSECURE: config.get('SPICEDB_INSECURE', { infer: true }),
        }),
    },
  ],
  exports: [AuthzClient],
})
export class AuthzModule {}
