import { Module } from '@nestjs/common';

import { CustomIntegrationSecretService } from './custom-integration-secret.service.js';
import { IntegrationsIngestController } from './integrations-ingest.controller.js';
import { IntegrationsController } from './integrations.controller.js';
import { IntegrationsService } from './integrations.service.js';

/**
 * Self-serve custom integrations: admin CRUD (`IntegrationsController`) plus the
 * separate `@Public()` inbound-push endpoint (`IntegrationsIngestController`).
 * Not registered in `ConnectorRegistry` — a `CustomWebhookConnector` is built per
 * request from the loaded `custom_integrations` row.
 */
@Module({
  controllers: [IntegrationsController, IntegrationsIngestController],
  providers: [IntegrationsService, CustomIntegrationSecretService],
})
export class IntegrationsModule {}
