import {
  BadRequestException,
  Controller,
  HttpCode,
  Inject,
  Logger,
  Post,
  type RawBodyRequest,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import type { Connector, RawArtifact } from '@fde/core';
import { ConnectorRegistry } from '@fde/connectors';

import { CONNECTOR_REGISTRY } from '../admin/admin.tokens.js';
import { Public } from '../request-context/metadata.js';
import { WebhookLandingService } from './webhook-landing.service.js';

const LINEAR_CONNECTOR_ID = 'linear';

export interface LinearWebhookOutcome {
  status: 'accepted' | 'ignored';
}

/** Express lower-cases header names and arrays them on repeat; `ConnectorWebhookRequest.headers` wants one string per key. */
function flattenHeaders(headers: Request['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') out[key] = value;
    else if (Array.isArray(value) && value.length > 0) out[key] = value[0] as string;
  }
  return out;
}

/**
 * Linear's organization id — a top-level field on every Linear webhook
 * payload (Linear's webhook docs: each delivery carries `organizationId`
 * alongside `type` / `action` / `data`). Parsed from the same raw bytes
 * `handleWebhook` already verified the signature over; this is a second parse
 * of already-authenticated bytes, not a second trust decision — the payload
 * is only ever acted on after `handleWebhook` has returned successfully.
 */
function extractLinearScopeRef(rawBody: Uint8Array): string | null {
  try {
    const payload = JSON.parse(Buffer.from(rawBody).toString('utf8')) as {
      organizationId?: unknown;
    };
    return typeof payload.organizationId === 'string' && payload.organizationId
      ? payload.organizationId
      : null;
  } catch {
    return null;
  }
}

/**
 * Linear webhook receiver — the connector-agnostic pattern from
 * `auth/webhook.controller.ts` (WorkOS) applied to `@fde/connectors`:
 * `@Public()`, raw body required, and the connector's own
 * `handleWebhook`/`LINEAR_WEBHOOK_SECRET` verification runs before anything
 * here is trusted. `WebhookLandingService` owns everything past verification
 * (scope lookup, credential resolution, ACL, durable landing) — a future
 * GitHub receiver is a second thin controller like this one calling the same
 * service.
 */
@ApiExcludeController()
@Controller('webhooks/linear')
export class LinearWebhookController {
  private readonly logger = new Logger(LinearWebhookController.name);

  constructor(
    @Inject(CONNECTOR_REGISTRY) private readonly registry: ConnectorRegistry,
    @Inject(WebhookLandingService) private readonly landing: WebhookLandingService,
  ) {}

  @Public()
  @Post()
  @HttpCode(200)
  async receive(@Req() req: RawBodyRequest<Request>): Promise<LinearWebhookOutcome> {
    if (req.rawBody === undefined) {
      // `main.ts` creates the app with `rawBody: true`; if the exact bytes
      // weren't captured we cannot verify the signature — fail, never fall
      // back to an empty body (mirrors `auth/webhook.controller.ts`).
      throw new BadRequestException('raw request body unavailable — cannot verify signature');
    }

    // The registry's `ConnectorBuildContext.engagementRetentionPolicy` only
    // matters once we know which engagement this is (resolved below, from
    // `connector_config`, inside `WebhookLandingService`). `handleWebhook`
    // itself never routes or authenticates on it; it only affects whether
    // `LinearConnector.toArtifact` captures the issue description into
    // `artifact.body` at all. `full-retention` is the maximal-capture choice,
    // so a placeholder here never *loses* data — `landConnectorArtifact` is
    // what applies the real, per-engagement policy when deciding what to
    // actually persist.
    const connector: Connector = this.registry.build(LINEAR_CONNECTOR_ID, {
      engagementRetentionPolicy: 'full-retention',
    });

    let artifacts: RawArtifact[];
    try {
      artifacts = await connector.handleWebhook({
        headers: flattenHeaders(req.headers),
        rawBody: req.rawBody,
        connectorId: LINEAR_CONNECTOR_ID,
      });
    } catch (err) {
      this.logger.warn(
        `webhook.linear.rejected: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new UnauthorizedException('invalid linear webhook signature');
    }

    if (artifacts.length === 0) return { status: 'ignored' };

    const scopeRef = extractLinearScopeRef(req.rawBody);
    if (!scopeRef) {
      this.logger.warn('webhook.linear.no_scope_ref: verified payload has no organizationId');
      return { status: 'ignored' };
    }

    const result = await this.landing.landWebhookArtifacts({
      connectorId: LINEAR_CONNECTOR_ID,
      connector,
      externalScopeRef: scopeRef,
      artifacts,
    });

    return { status: result.matched ? 'accepted' : 'ignored' };
  }
}
