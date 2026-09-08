import { Module } from '@nestjs/common';

import { AuthzModule } from './authz/authz.module.js';
import { AppConfigModule } from './config/config.module.js';
import { DbModule } from './db/db.module.js';
import { EngagementsController } from './engagements/engagements.controller.js';
import { HealthController } from './health/health.controller.js';
import { KeyProviderModule } from './key-provider/key-provider.module.js';
import { MeController } from './me/me.controller.js';
import { RequestContextModule } from './request-context/request-context.module.js';

/**
 * The API composition root. `RequestContextModule` registers the app-wide
 * guard + interceptor that every non-`@Public()` route below runs behind; the
 * `Controller`s here hold only the minimal M1 routes that prove the seam
 * (`/healthz`, `/me`, `/engagements`, `/engagements/:id/audit`). SSO + the
 * WorkOS webhook live in `AuthModule` (imported via `RequestContextModule`).
 */
@Module({
  imports: [AppConfigModule, DbModule, KeyProviderModule, AuthzModule, RequestContextModule],
  controllers: [HealthController, MeController, EngagementsController],
})
export class AppModule {}
