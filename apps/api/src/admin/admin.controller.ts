import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { CONNECTOR_AUTH_KINDS, RETENTION_POLICIES } from '@fde/core';

import { EngagementScope } from '../request-context/metadata.js';
import { AdminService, parsePutConnectorBody, parseSyncBody } from './admin.service.js';

class ConnectorSyncResponse {
  @ApiProperty({ type: String, nullable: true, enum: ['idle', 'running', 'error'] })
  status!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) lastRunAt!: string | null;
  @ApiProperty({ type: Boolean }) cursorPresent!: boolean;
}

class ConnectorResponse {
  @ApiProperty({ type: String }) connector!: string;
  @ApiProperty({ type: String, enum: [...CONNECTOR_AUTH_KINDS] }) authKind!: string;
  @ApiProperty({ type: Boolean }) enabled!: boolean;
  @ApiProperty({ type: String, enum: [...RETENTION_POLICIES] }) effectiveRetention!: string;
  @ApiProperty({ type: Boolean, description: 'a credential is stored — never the secret itself' })
  hasCredential!: boolean;
  @ApiProperty({ type: ConnectorSyncResponse }) sync!: ConnectorSyncResponse;
}

class PutConnectorBody {
  @ApiPropertyOptional({ type: Boolean }) enabled?: boolean;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    enum: [...RETENTION_POLICIES],
    description: 'null clears the override (inherit the engagement policy)',
  })
  retentionOverride?: string | null;
  @ApiPropertyOptional({
    type: String,
    description:
      'cleartext secret (bearer token / Nango connection id) — encrypted at rest, never returned',
  })
  credential?: string;
}

class SyncBody {
  @ApiProperty({ type: String, enum: ['backfill', 'incremental'] }) mode!: string;
}

class SyncStartedResponse {
  @ApiProperty({ type: String }) workflowId!: string;
}

/**
 * `/admin` connector configuration. All routes are engagement-scoped
 * (`@EngagementScope('id')` → the interceptor opens `withEngagement`, so the
 * service can encrypt the credential with the engagement DEK). `GET` is
 * `canViewEngagement`-gated under `AUTHZ_ENFORCE`; `PUT` and `POST …/sync` are
 * admin-only and always enforced.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('engagements')
export class AdminController {
  constructor(@Inject(AdminService) private readonly admin: AdminService) {}

  @Get(':id/connectors')
  @EngagementScope('id')
  @ApiOkResponse({ type: [ConnectorResponse] })
  async listConnectors(
    @Param('id', new ParseUUIDPipe()) _id: string,
  ): Promise<ConnectorResponse[]> {
    return this.admin.listConnectors();
  }

  @Put(':id/connectors/:connectorId')
  @EngagementScope('id')
  @ApiOkResponse({ type: ConnectorResponse })
  async putConnector(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @Param('connectorId') connectorId: string,
    @Body() body: PutConnectorBody,
  ): Promise<ConnectorResponse> {
    return this.admin.putConnector(connectorId, parsePutConnectorBody(body));
  }

  @Post(':id/connectors/:connectorId/sync')
  @HttpCode(200)
  @EngagementScope('id')
  @ApiOkResponse({ type: SyncStartedResponse })
  async startSync(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @Param('connectorId') connectorId: string,
    @Body() body: SyncBody,
  ): Promise<SyncStartedResponse> {
    return this.admin.startSync(connectorId, parseSyncBody(body).mode);
  }
}
