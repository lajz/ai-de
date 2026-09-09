import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import {
  ACCESS_LOG_ACTIONS,
  type AccessLogAction,
  EVIDENCE_RELATIONS,
  FACT_TYPES,
  type EngagementId,
  type UserId,
} from '@fde/core';
import { listAccess, logAccess } from '@fde/audit';
import { AuthzClient, ENGAGEMENT_ROLES, type EngagementRole } from '@fde/authz';
import { engagements } from '@fde/db';
import { desc } from 'drizzle-orm';

import type { Env } from '../config/env.js';
import { EngagementScope } from '../request-context/metadata.js';
import { getEngagementContext, getRequestContext } from '../request-context/request-context.js';
import { RetrievalService } from '../retrieval/retrieval.service.js';

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

class EvidenceCitationResponse {
  @ApiProperty({ type: String }) sourceId!: string;
  @ApiProperty({ type: String, nullable: true }) permalink!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'decrypted supporting quote' })
  quote!: string | null;
  @ApiProperty({ type: Number, nullable: true }) charStart!: number | null;
  @ApiProperty({ type: Number, nullable: true }) charEnd!: number | null;
  @ApiProperty({ type: String, enum: [...EVIDENCE_RELATIONS] }) relation!: string;
}

class FactResponse {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String, enum: [...FACT_TYPES] }) type!: string;
  @ApiProperty({ type: String }) summary!: string;
  @ApiProperty({ type: String, nullable: true, description: 'decrypted detail' })
  body!: string | null;
  @ApiProperty({ type: String }) status!: string;
  @ApiProperty({ type: Number, nullable: true }) confidence!: number | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) occurredAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: [EvidenceCitationResponse] }) citations!: EvidenceCitationResponse[];
}

class QaBody {
  @ApiProperty({ type: String }) question!: string;
}

class QaCitationResponse {
  @ApiProperty({ type: String }) sourceId!: string;
  @ApiProperty({ type: String, nullable: true }) permalink!: string | null;
  @ApiProperty({ type: String }) quote!: string;
}

class QaResponse {
  @ApiProperty({ type: String }) answer!: string;
  @ApiProperty({ type: [QaCitationResponse] }) citations!: QaCitationResponse[];
}

class AddMemberBody {
  @ApiProperty({ type: String, format: 'uuid' }) userId!: string;
  @ApiProperty({ type: String, enum: [...ENGAGEMENT_ROLES] }) role!: EngagementRole;
}

class AddMemberResponse {
  @ApiProperty({ type: Boolean }) ok!: boolean;
}

@ApiTags('engagements')
@ApiBearerAuth()
@Controller('engagements')
export class EngagementsController {
  private readonly enforce: boolean;

  constructor(
    @Inject(AuthzClient) private readonly authz: AuthzClient,
    @Inject(RetrievalService) private readonly retrieval: RetrievalService,
    @Inject(ConfigService) config: ConfigService<Env, true>,
  ) {
    this.enforce = config.get('AUTHZ_ENFORCE', { infer: true }) === 'true';
  }

  /**
   * Every engagement visible to the caller's tenant (RLS-scoped), newest first.
   * With `AUTHZ_ENFORCE=true` the RLS-scoped set is additionally filtered through
   * `listViewableEngagements` — platform-role gate layered on top of RLS.
   */
  @Get()
  @ApiOkResponse({ type: [EngagementResponse] })
  async list(): Promise<EngagementResponse[]> {
    const { tx, tenantId, userId } = getRequestContext();
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

    const mapped = rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
    if (!this.enforce) return mapped;

    // "first observed" — parent each engagement to its tenant so a tenant admin
    // resolves `view` through `parent_tenant->administer`. Idempotent (TOUCH);
    // bounded by this tenant's own engagement count. M5 moves this to the
    // connector's engagement-provisioning path.
    await Promise.all(
      mapped.map((r) => this.authz.linkEngagementToTenant(r.id as EngagementId, tenantId)),
    );
    const viewable = new Set(await this.authz.listViewableEngagements(userId));
    return mapped.filter((r) => viewable.has(r.id as EngagementId));
  }

  /**
   * The tenant-facing access log for one engagement (`@fde/audit` `listAccess`).
   * Engagement-scoped: the interceptor opens `withEngagement` first. Reading it
   * is itself a `content_read`, logged in the same transaction (architecture,
   * read-path step 4). With `AUTHZ_ENFORCE=true`, `canViewEngagement` gates it
   * (403) on top of the RLS scoping the interceptor already applied.
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

    if (this.enforce) {
      // M5: also record the denied decision on the access_log (authz_decision).
      await this.authz.linkEngagementToTenant(engagement.id, tenantId);
      if (!(await this.authz.canViewEngagement(userId, engagement.id))) {
        throw new ForbiddenException('not authorized to view this engagement');
      }
    }

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

  /**
   * This engagement's extracted `facts` (newest first) with their `evidence`
   * citations. Engagement-scoped: the interceptor opened `withEngagement`, so
   * `RetrievalService` decrypts `facts.body` / `evidence.quote` with the request
   * cipher — only after the `canViewEngagement` gate (`AUTHZ_ENFORCE=true`, 403).
   * Reading is a `content_read`, logged in the same transaction.
   */
  @Get(':id/facts')
  @EngagementScope('id')
  @ApiOkResponse({ type: [FactResponse] })
  async facts(@Param('id', new ParseUUIDPipe()) _id: string): Promise<FactResponse[]> {
    return this.retrieval.listFacts();
  }

  /**
   * Single-engagement retrieval Q&A. `RetrievalService` embeds the question,
   * runs a pgvector cosine KNN over this engagement's chunk embeddings, applies
   * the authz gate **before** the LLM, decrypts the surviving sources' context
   * post-gate, and answers from that context only. Logs a `retrieval` row and a
   * `content_read` row (architecture read-path step 4).
   */
  @Post(':id/qa')
  @HttpCode(200)
  @EngagementScope('id')
  @ApiOkResponse({ type: QaResponse })
  async qa(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @Body() body: QaBody,
  ): Promise<QaResponse> {
    const question = (body as { question?: unknown }).question;
    if (typeof question !== 'string' || question.trim() === '') {
      throw new BadRequestException('question must be a non-empty string');
    }
    return this.retrieval.answerQuestion(question);
  }

  /**
   * Grant a user a platform role on this engagement — the relationship-seeding
   * seam (`@fde/authz` `grantEngagementRole`). Admin-only: the caller must be an
   * engagement admin or a tenant admin, and the grantee must already belong to
   * the tenant (present in SpiceDB via the SSO seam). Always enforced (it
   * mutates authz state) regardless of `AUTHZ_ENFORCE`. M5 adds source-ACL
   * seeding alongside this.
   */
  @Post(':id/members')
  @EngagementScope('id')
  @ApiCreatedResponse({ type: AddMemberResponse })
  async addMember(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @Body() body: AddMemberBody,
  ): Promise<AddMemberResponse> {
    const engagement = getEngagementContext();
    const { userId, tenantId } = getRequestContext();

    // Authorize before doing any work or echoing validation detail back.
    const allowed =
      (await this.authz.canAdministerEngagement(userId, engagement.id)) ||
      (await this.authz.canAdministerTenant(userId, tenantId));
    if (!allowed) throw new ForbiddenException('not authorized to manage engagement members');

    const { userId: grantee, role } = parseAddMemberBody(body);

    // Confine the grantee to the caller's tenant: only seed an engagement role
    // for a user who already belongs to this tenant in SpiceDB (the SSO seam
    // sets `tenant#member` on every login). This keeps the whole check in the
    // authz store — no cross-tenant tuple is ever written — and avoids a
    // second, tenant-scoping-sensitive datastore in the path.
    if (!(await this.authz.isTenantMember(grantee as UserId, tenantId))) {
      throw new BadRequestException('userId is not a member of this tenant');
    }
    // TODO(M5): write a `role_granted` access_log row here (needs the action added
    // to `@fde/core` ACCESS_LOG_ACTIONS) so grants show in the tenant audit view.
    await this.authz.linkEngagementToTenant(engagement.id, tenantId);
    await this.authz.grantEngagementRole(grantee as UserId, engagement.id, role);
    return { ok: true };
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Shape-check the `POST /engagements/:id/members` body. Throws 400 on anything off. */
function parseAddMemberBody(body: unknown): { userId: string; role: EngagementRole } {
  if (typeof body !== 'object' || body === null) {
    throw new BadRequestException('request body is required');
  }
  const { userId, role } = body as Record<string, unknown>;
  if (typeof userId !== 'string' || !UUID.test(userId)) {
    throw new BadRequestException('userId must be a UUID');
  }
  if (typeof role !== 'string' || !(ENGAGEMENT_ROLES as readonly string[]).includes(role)) {
    throw new BadRequestException(`role must be one of: ${ENGAGEMENT_ROLES.join(', ')}`);
  }
  return { userId, role: role as EngagementRole };
}
