import { BadRequestException, Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { ACCESS_LOG_ACTIONS, type AccessLogAction } from '@fde/core';
import { listAccess, logAccess } from '@fde/audit';
import { engagements } from '@fde/db';
import { desc } from 'drizzle-orm';

import { EngagementScope } from '../request-context/metadata.js';
import { getEngagementContext, getRequestContext } from '../request-context/request-context.js';

class EngagementResponse {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String }) endCustomerName!: string;
  @ApiProperty({ type: String, enum: ['us', 'eu'] }) regionPin!: string;
  @ApiProperty({ type: String }) retentionPolicy!: string;
  @ApiProperty({ type: String, enum: ['active', 'closed', 'shredded'] }) status!: string;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
}

class AuditRowResponse {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String, nullable: true }) engagementId!: string | null;
  @ApiProperty({ type: String }) actorType!: string;
  @ApiProperty({ type: String, nullable: true }) actorId!: string | null;
  @ApiProperty({ type: String }) action!: string;
  @ApiProperty({ type: String, nullable: true }) resourceType!: string | null;
  @ApiProperty({ type: String, nullable: true }) resourceId!: string | null;
  @ApiProperty({ type: Object, nullable: true }) authzDecision!: Record<string, unknown> | null;
  @ApiProperty({ type: String, nullable: true }) reason!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
}

class AuditPageResponse {
  @ApiProperty({ type: [AuditRowResponse] }) rows!: AuditRowResponse[];
  @ApiPropertyOptional({ type: String, description: 'pass back as ?cursor for the next page' })
  nextCursor?: string;
}

@ApiTags('engagements')
@ApiBearerAuth()
@Controller('engagements')
export class EngagementsController {
  /** Every engagement visible to the caller's tenant (RLS-scoped), newest first. */
  @Get()
  @ApiOkResponse({ type: [EngagementResponse] })
  async list(): Promise<EngagementResponse[]> {
    const { tx } = getRequestContext();
    const rows = await tx
      .select({
        id: engagements.id,
        endCustomerName: engagements.endCustomerName,
        regionPin: engagements.regionPin,
        retentionPolicy: engagements.retentionPolicy,
        status: engagements.status,
        createdAt: engagements.createdAt,
      })
      .from(engagements)
      .orderBy(desc(engagements.createdAt));

    return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
  }

  /**
   * The tenant-facing access log for one engagement (`@fde/audit` `listAccess`).
   * Engagement-scoped: the interceptor opens `withEngagement` first. Reading it
   * is itself a `content_read`, logged in the same transaction (architecture,
   * read-path step 4).
   */
  @Get(':id/audit')
  @EngagementScope('id')
  @ApiOkResponse({ type: AuditPageResponse })
  async audit(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('action') action?: string,
    @Query('actorId') actorId?: string,
  ): Promise<AuditPageResponse> {
    const { tx, userId, tenantId } = getRequestContext();
    const engagement = getEngagementContext();

    if (action && !ACCESS_LOG_ACTIONS.includes(action as AccessLogAction)) {
      throw new BadRequestException(`unknown action filter: ${action}`);
    }
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && !Number.isFinite(parsedLimit)) {
      throw new BadRequestException('limit must be a number');
    }

    await logAccess(tx, {
      tenantId,
      actorType: 'user',
      actorId: userId,
      action: 'content_read',
      engagementId: engagement.id,
      resourceType: 'access_log',
      resourceId: engagement.id,
    });

    let page: Awaited<ReturnType<typeof listAccess>>;
    try {
      page = await listAccess(tx, {
        engagementId: engagement.id,
        limit: parsedLimit,
        cursor,
        action: action as AccessLogAction | undefined,
        actorId,
      });
    } catch (err) {
      if (err instanceof Error && /cursor/i.test(err.message)) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }

    return {
      rows: page.rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
      nextCursor: page.nextCursor,
    };
  }
}
