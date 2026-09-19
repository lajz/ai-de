import { Module } from '@nestjs/common';

import { AdminModule } from '../admin/admin.module.js';
import { GitHubWebhookController } from './github-webhook.controller.js';
import { LinearWebhookController } from './linear-webhook.controller.js';
import { WebhookLandingService } from './webhook-landing.service.js';

/**
 * Connector-agnostic webhook delivery. `AdminModule` is imported for its
 * exported `CONNECTOR_REGISTRY` — the receiver builds connectors from the same
 * process-wide registry `/admin` uses, rather than a second one. One
 * controller per connector (`webhooks/linear`, `webhooks/github`, mirroring
 * the existing `webhooks/workos` convention); `WebhookLandingService` is the
 * shared, connector-agnostic landing path every controller calls.
 */
@Module({
  imports: [AdminModule],
  controllers: [LinearWebhookController, GitHubWebhookController],
  providers: [WebhookLandingService],
})
export class WebhooksModule {}
