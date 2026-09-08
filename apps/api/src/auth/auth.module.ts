import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../config/env.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { DirectorySyncService } from './directory-sync.service.js';
import { FakeWorkOsService } from './fake-workos.service.js';
import { OrgTenantMap } from './org-tenant-map.js';
import { SessionService } from './session.service.js';
import { UsersService } from './users.service.js';
import { WebhookController } from './webhook.controller.js';
import { WorkOsService } from './workos.service.js';
import { WORKOS } from './workos.types.js';

/**
 * SSO + SCIM. The `WORKOS` provider is the live `WorkOsService` when
 * `WORKOS_API_KEY` is set, and `FakeWorkOsService` otherwise — so the whole
 * seam (login → callback → session, and the webhook receiver) is exercisable
 * with no WorkOS account. `SessionService` is exported for the request-context
 * guard.
 */
@Module({
  controllers: [AuthController, WebhookController],
  providers: [
    AuthService,
    UsersService,
    SessionService,
    OrgTenantMap,
    DirectorySyncService,
    {
      provide: WORKOS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        config.get('WORKOS_API_KEY', { infer: true })
          ? new WorkOsService(config)
          : new FakeWorkOsService(config.get('WORKOS_WEBHOOK_SECRET', { infer: true })),
    },
  ],
  exports: [SessionService, WORKOS],
})
export class AuthModule {}
