import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createDbClient, type Database, type DbHandle } from '@fde/db';

import type { Env } from '../config/env.js';

/** Injection token for the shared `@fde/db` `Database`. */
export const DB = Symbol('DB');
/** Injection token for the underlying handle (so shutdown can close the pool). */
export const DB_HANDLE = Symbol('DB_HANDLE');

/**
 * One `postgres` pool for the process, shared by every request. Handlers never
 * touch it directly — the request-context interceptor opens `withTenant` /
 * `withEngagement` against it and hands the transaction to handlers via
 * `AsyncLocalStorage` (see `request-context/`).
 */
@Global()
@Module({
  providers: [
    {
      provide: DB_HANDLE,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): DbHandle =>
        createDbClient({ url: config.get('DATABASE_URL', { infer: true }) }),
    },
    {
      provide: DB,
      inject: [DB_HANDLE],
      useFactory: (handle: DbHandle): Database => handle.db,
    },
  ],
  exports: [DB],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(DB_HANDLE) private readonly handle: DbHandle) {}

  async onApplicationShutdown(): Promise<void> {
    await this.handle.close();
  }
}
