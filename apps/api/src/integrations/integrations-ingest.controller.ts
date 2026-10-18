import {
  BadRequestException,
  Controller,
  ForbiddenException,
  HttpCode,
  Inject,
  Logger,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  PayloadTooLargeException,
  Post,
  type RawBodyRequest,
  Req,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { CustomPayloadError, CustomWebhookConnector } from '@fde/connectors';
import {
  canonicalRecordSchema,
  CustomMappingValidationError,
  normalizeCustomArtifact,
  type EngagementId,
  type RetentionPolicy,
  type TenantId,
} from '@fde/core';
import type { KeyProvider } from '@fde/crypto';
import {
  selectCustomIntegrationByIdBare,
  selectEngagementRetentionPolicy,
  touchCustomIntegrationLastIngestedAt,
  withTenant,
  type Database,
} from '@fde/db';
import { landConnectorArtifactWithGraph, type GraphWriteTally } from '@fde/identity';
import { ZodError } from 'zod';

import { DB } from '../db/db.module.js';
import { KEY_PROVIDER } from '../key-provider/key-provider.module.js';
import { NoTransactionScope, Public } from '../request-context/metadata.js';
import { CustomIntegrationSecretService } from './custom-integration-secret.service.js';

/** Largest accepted ingest body. Checked before anything is parsed. */
export const MAX_CUSTOM_INGEST_BYTES = 256 * 1024;

export interface CustomIngestOutcome {
  status: 'accepted';
  sourceId: string;
  graph: GraphWriteTally;
}

function bearerFrom(header: string | undefined): string | undefined {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return m?.[1];
}

/**
 * Public inbound-push endpoint for a custom integration. There is no session
 * and no api key: the per-integration bearer secret IS the credential, and the
 * `custom_integrations` row is resolved by primary key before any tenant is
 * known (the table has no RLS — see `schema/custom-integrations.ts`). This
 * route therefore resolves its own `(tenantId, engagementId)` from the row.
 *
 * Status codes are deliberate: a correct secret posted under another
 * engagement's URL is a 404, identical to a nonexistent integration, so the
 * endpoint never reveals which tenant owns which id.
 */
@ApiExcludeController()
@Controller('engagements')
export class IntegrationsIngestController {
  private readonly logger = new Logger(IntegrationsIngestController.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(KEY_PROVIDER) private readonly keyProvider: KeyProvider,
    @Inject(CustomIntegrationSecretService)
    private readonly secrets: CustomIntegrationSecretService,
  ) {}

  @Public()
  @NoTransactionScope()
  @Post(':engagementId/integrations/:integrationId/ingest')
  @HttpCode(200)
  async ingest(
    @Param('engagementId', new ParseUUIDPipe()) engagementId: string,
    @Param('integrationId', new ParseUUIDPipe()) integrationId: string,
    @Req() req: RawBodyRequest<Request>,
  ): Promise<CustomIngestOutcome> {
    // 1. size, before parsing anything
    if (req.rawBody === undefined) {
      throw new BadRequestException(
        'request body unavailable — send Content-Type: application/json',
      );
    }
    if (req.rawBody.byteLength > MAX_CUSTOM_INGEST_BYTES) {
      throw new PayloadTooLargeException(`body exceeds ${MAX_CUSTOM_INGEST_BYTES} bytes`);
    }

    // 2. credential shape
    const bearer = bearerFrom(req.headers.authorization);
    if (!bearer) throw new UnauthorizedException('missing bearer secret');

    // 3. bare pre-tenant lookup; wrong-engagement is indistinguishable from not-found
    const row = await selectCustomIntegrationByIdBare(this.db, integrationId);
    if (!row || row.engagementId !== engagementId) {
      throw new NotFoundException('integration not found');
    }

    // 4. secret, 5. enabled
    if (!this.secrets.verify(bearer, row.secretHash)) {
      throw new UnauthorizedException('invalid secret');
    }
    if (!row.enabled) throw new ForbiddenException('integration is disabled');

    const tenantId = row.tenantId as TenantId;
    const engId = row.engagementId as EngagementId;
    const build = (retention: RetentionPolicy) =>
      new CustomWebhookConnector({
        integrationId: row.id,
        mapping: row.mapping,
        engagementRetentionPolicy: retention,
      });

    // 6-8. parse + validate everything BEFORE any write
    const probe = build('full-retention');
    let artifact;
    try {
      const artifacts = await probe.handleWebhook({
        headers: {},
        rawBody: req.rawBody,
        connectorId: probe.id,
      });
      artifact = artifacts[0]!;
      // `landConnectorArtifactWithGraph` does not schema-validate normalize()'s
      // output, so this explicit pre-check is what actually guards the graph.
      const { records } = normalizeCustomArtifact(row.mapping, probe.id, artifact.raw ?? {}, {
        strict: true,
      });
      canonicalRecordSchema.array().parse(records);
    } catch (err) {
      if (err instanceof CustomPayloadError) throw new BadRequestException(err.message);
      if (err instanceof CustomMappingValidationError) {
        throw new UnprocessableEntityException({ message: 'mapping failed', issues: err.issues });
      }
      if (err instanceof ZodError) {
        throw new UnprocessableEntityException({
          message: 'mapped records are not valid',
          issues: err.issues.map((i) => ({ at: i.path.join('.'), message: i.message })),
        });
      }
      throw err;
    }

    // 9. land (opens its own withEngagement tx)
    const retention = await this.retentionFor(tenantId, engId);
    const connector = build(retention);
    const aclSnapshot = await connector.resolveAcl();
    const result = await landConnectorArtifactWithGraph(this.db, this.keyProvider, {
      tenantId,
      engagementId: engId,
      connectorId: connector.id,
      retentionPolicy: connector.retentionPolicy,
      artifact,
      aclSnapshot,
      connector,
    });

    // 10. best-effort bookkeeping
    try {
      await touchCustomIntegrationLastIngestedAt(this.db, row.id);
    } catch (err) {
      this.logger.warn(
        `custom_ingest.touch_failed ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // metadata-only
    this.logger.log(
      `custom_ingest.accepted ${JSON.stringify({ integrationId: row.id, ...result.graph })}`,
    );
    return { status: 'accepted', sourceId: result.sourceId, graph: result.graph };
  }

  private async retentionFor(
    tenantId: TenantId,
    engagementId: EngagementId,
  ): Promise<RetentionPolicy> {
    return (
      (await withTenant(this.db, tenantId, (tx) =>
        selectEngagementRetentionPolicy(tx, tenantId, engagementId),
      )) ?? 'full-retention'
    );
  }
}
