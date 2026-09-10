import { Module } from '@nestjs/common';
import { createDefaultConnectorRegistry, type ConnectorRegistry } from '@fde/connectors';

import { TemporalModule } from '../temporal/temporal.module.js';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';
import { CONNECTOR_REGISTRY } from './admin.tokens.js';

/**
 * The `/admin` connector-configuration API. One process-wide
 * `ConnectorRegistry` (Granola backed by `HttpGranolaClient` when
 * `GRANOLA_API_KEY` is set, `FakeGranolaClient` otherwise — same real-vs-fake
 * flip as `@fde/workers`). `TemporalModule` is `@Global`, imported here for
 * clarity. Tests bind fakes over `CONNECTOR_REGISTRY` / `AuthzClient` /
 * `TemporalConnectorSync`.
 */
@Module({
  imports: [TemporalModule],
  controllers: [AdminController],
  providers: [
    {
      provide: CONNECTOR_REGISTRY,
      useFactory: (): ConnectorRegistry => createDefaultConnectorRegistry(process.env),
    },
    AdminService,
  ],
})
export class AdminModule {}
