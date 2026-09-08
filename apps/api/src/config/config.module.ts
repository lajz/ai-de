import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule, ConfigService } from '@nestjs/config';

import { type Env, validateEnv } from './env.js';

/** Typed accessor for the validated environment. */
export type AppConfig = ConfigService<Env, true>;

/**
 * Loads `.env` (when present) + `process.env`, validates the whole set through
 * `envSchema`, and exposes it as a `ConfigService<Env, true>`. `isGlobal` so
 * every module can inject `ConfigService` without re-importing.
 */
@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // repo runs one shared .env at the root (symlinked into each worktree);
      // '.env' covers running from the repo root, '../../.env' from apps/api.
      envFilePath: ['.env', '../../.env'],
      validate: validateEnv,
    }),
  ],
  exports: [NestConfigModule],
})
export class AppConfigModule {}

export { ConfigService };
