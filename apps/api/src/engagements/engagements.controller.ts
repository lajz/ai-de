import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  GoneException,
  HttpCode,
  Inject,
  type MessageEvent,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  RequestMethod,
  Sse,
  UnauthorizedException,
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
import { EngagementShreddedError, type KeyProvider } from '@fde/crypto';
import {
  engagements,
  rotateEngagementKey,
  shredEngagement,
  withTenant,
  type Database,
} from '@fde/db';
import type { ChatMessage } from '@fde/llm';
import { desc, eq } from 'drizzle-orm';
import { from, map, type Observable } from 'rxjs';

import type { Env } from '../config/env.js';
import { DB } from '../db/db.module.js';
import { KEY_PROVIDER } from '../key-provider/key-provider.module.js';
import { EngagementScope, NoTransactionScope } from '../request-context/metadata.js';
import { getEngagementContext, getRequestContext } from '@fde/request-context';
import { AgenticQaService } from '../retrieval/agentic-qa.service.js';
import { RetrievalService } from '../retrieval/retrieval.service.js';
import { TemporalCryptoShred } from '../temporal/temporal.module.js';
import type { AuthedRequest } from '../request-context/tenant-context.guard.js';

class EngagementResponse {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String }) endCustomerName!: string;
  @ApiProperty({ type: String, enum: ['us', 'eu'] }) regionPin!: string;
  @ApiProperty({ type: String }) retentionPolicy!: string;
  @ApiProperty({ type: String, enum: ['active', 'closed', 'shredded'] }) status!: string;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'customer-supplied KMS key ARN when BYOK/CMEK is in effect; absent on the platform-managed tenant key',
  })
  byokKeyArn!: string | null;
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

class FactPageResponse {
  @ApiProperty({ type: [FactResponse] }) rows!: FactResponse[];
  @ApiPropertyOptional({ type: String, description: 'pass back as ?cursor for the next page' })
  nextCursor?: string;
}

class QaBody {
  @ApiProperty({ type: String }) question!: string;
}

class QaHistoryTurnBody {
  @ApiProperty({ type: String, enum: ['user', 'assistant'] }) role!: 'user' | 'assistant';
  @ApiProperty({ type: String }) content!: string;
}

class AgenticQaBody extends QaBody {
  @ApiPropertyOptional({
    type: [QaHistoryTurnBody],
    description:
      'Prior turns of this conversation, oldest first, not including `question` — the ' +
      'agentic loop is stateless across requests, so a follow-up question only has any ' +
      'memory of earlier ones if the caller resends them here.',
  })
  history?: QaHistoryTurnBody[];
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

class CryptoShredBody {
  @ApiProperty({ type: String, description: 'why this engagement is being crypto-shredded' })
  reason!: string;
}

class CryptoShredResponse {
  @ApiProperty({ type: Boolean }) ok!: boolean;
  @ApiProperty({
    type: Boolean,
    description: 'true if the engagement was already shredded before this call',
  })
  alreadyShredded!: boolean;
}

class SetByokKeyBody {
  @ApiProperty({
    type: String,
    description: "customer-supplied KMS key ARN to BYOK/CMEK-wrap this engagement's DEK under",
  })
  byokKeyArn!: string;
}

class SetByokKeyResponse {
  @ApiProperty({ type: Boolean }) ok!: boolean;
  @ApiProperty({ type: String }) byokKeyArn!: string;
}

@ApiTags('engagements')
@ApiBearerAuth()
@Controller('engagements')
export class EngagementsController {
  private readonly enforce: boolean;

  constructor(
    @Inject(AuthzClient) private readonly authz: AuthzClient,
    @Inject(RetrievalService) private readonly retrieval: RetrievalService,
    @Inject(AgenticQaService) private readonly agenticQa: AgenticQaService,
    @Inject(DB) private readonly db: Database,
    @Inject(TemporalCryptoShred) private readonly temporalCryptoShred: TemporalCryptoShred,
    @Inject(KEY_PROVIDER) private readonly keyProvider: KeyProvider,
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
        byokKeyArn: engagements.byokKeyArn,
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
   * citations — keyset-paginated over `(created_at, id)`, same query-param
   * shape as `audit()` above. Engagement-scoped: the interceptor opened
   * `withEngagement`, so `RetrievalService` decrypts `facts.body` /
   * `evidence.quote` with the request cipher — only after the
   * `canViewEngagement` gate (`AUTHZ_ENFORCE=true`, 403). Reading is a
   * `content_read`, logged in the same transaction.
   */
  @Get(':id/facts')
  @EngagementScope('id')
  @ApiOkResponse({ type: FactPageResponse })
  async facts(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<FactPageResponse> {
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && !Number.isFinite(parsedLimit)) {
      throw new BadRequestException('limit must be a number');
    }

    try {
      return await this.retrieval.listFacts({ limit: parsedLimit, cursor });
    } catch (err) {
      if (err instanceof Error && /cursor/i.test(err.message)) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
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
   * The agentic counterpart to `qa()`: streams tool-step + final-answer
   * events over SSE while `AgenticQaService` drives a multi-step tool-calling
   * loop over this engagement's MCP tools. `@NoTransactionScope()` — unlike
   * every other route here, the interceptor opens no ambient transaction for
   * this handler; each tool call (and the one-shot fallback) opens its own
   * short-lived one (see `AgenticQaService`'s doc comment). `engagementId`
   * comes from the route param only, closed over for the life of this
   * question, never taken from the model.
   *
   * Stateless across calls: `body.history` is the caller's own record of
   * this conversation's prior turns (oldest first) — this route holds none
   * of its own, so a follow-up question is only continuous with earlier ones
   * if the caller resends them.
   */
  @Sse(':id/qa/agentic', { method: RequestMethod.POST })
  @HttpCode(200)
  @NoTransactionScope()
  qaAgentic(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: AgenticQaBody,
    @Req() req: AuthedRequest,
  ): Observable<MessageEvent> {
    const question = (body as { question?: unknown }).question;
    if (typeof question !== 'string' || question.trim() === '') {
      throw new BadRequestException('question must be a non-empty string');
    }
    const history = parseQaHistory((body as { history?: unknown }).history);
    const session = req.fdeSession;
    if (!session) throw new UnauthorizedException('authentication required');

    const ctx = {
      tenantId: session.tenantId,
      userId: session.userId,
      engagementId: id as EngagementId,
    };
    return from(this.agenticQa.ask(question, ctx, history)).pipe(map((event) => ({ data: event })));
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

  /**
   * Crypto-shred: engagement DEK destruction + (best-effort) async ciphertext
   * purge + audit entry (M4). Genuinely irreversible — once this returns
   * `ok: true`, the engagement's content is permanently unreadable.
   *
   * `@NoTransactionScope()`, not `@EngagementScope()`: the interceptor's
   * `withEngagement` opens a crypto context by unwrapping the DEK this
   * handler is about to destroy — same chicken-and-egg shape as `qaAgentic`
   * and the `api_keys` RLS-exclusion precedent (PR #47). Identity comes
   * straight off `req.fdeSession`, and the one DB touch this handler needs
   * (a tenant-scoped existence check) opens its own short-lived `withTenant`.
   *
   * Authz is self-authorizing, not break-glass (`@fde/audit`'s
   * `break-glass.ts` is a distinct, second-person-approved mechanism for
   * internal employee support access) — the caller just needs engagement- or
   * tenant-admin authz, the same `canAdministerEngagement` /
   * `canAdministerTenant` pair `addMember` above already uses, checked before
   * any DB work or echoed validation detail.
   *
   * `shredEngagement()` runs directly and synchronously against `@fde/db` —
   * never via Temporal — so the security guarantee never depends on Temporal
   * being reachable. Only after that succeeds does this best-effort start the
   * `cryptoShredWorkflow` purge phase (storage hygiene, safe to run late or
   * not at all): a down/unconfigured Temporal is swallowed here and never
   * fails the shred response, same convention as `TemporalAgenticLinking`.
   */
  @Post(':id/crypto-shred')
  @HttpCode(200)
  @NoTransactionScope()
  async cryptoShred(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: CryptoShredBody,
    @Req() req: AuthedRequest,
  ): Promise<CryptoShredResponse> {
    const session = req.fdeSession;
    if (!session) throw new UnauthorizedException('authentication required');
    const engagementId = id as EngagementId;
    const { tenantId, userId } = session;

    // Authorize before doing any work.
    const allowed =
      (await this.authz.canAdministerEngagement(userId, engagementId)) ||
      (await this.authz.canAdministerTenant(userId, tenantId));
    if (!allowed) throw new ForbiddenException('not authorized to crypto-shred this engagement');

    const { reason } = parseCryptoShredBody(body);

    // Tenant-scoped existence check — RLS-invisible (another tenant's
    // engagement id) resolves to no row, same 404-on-cross-tenant convention
    // `TenantContextInterceptor` applies to every `@EngagementScope()` route.
    const [exists] = await withTenant(this.db, tenantId, (tx) =>
      tx.select({ id: engagements.id }).from(engagements).where(eq(engagements.id, engagementId)),
    );
    if (!exists) throw new NotFoundException('engagement not found');

    const didShred = await shredEngagement(this.db, {
      tenantId,
      engagementId,
      actorId: userId,
      reason,
    });

    if (this.temporalCryptoShred.configured) {
      try {
        await this.temporalCryptoShred.start({ tenantId, engagementId, actorId: userId, reason });
      } catch {
        // Best-effort — the DEK is already gone regardless of whether the
        // async purge could be scheduled. A future admin surface can list
        // engagements whose purge never ran and re-trigger it.
      }
    }

    return { ok: true, alreadyShredded: !didShred };
  }

  /**
   * Set or rotate BYOK/CMEK on an already-existing engagement: re-wraps its
   * *existing* DEK under a customer-supplied KMS key (`rotateEngagementKey` in
   * `@fde/db`) — no ciphertext is touched, only which key can unwrap the DEK
   * changes (see that function's doc comment for the locking/atomicity/failure
   * story). This does not create engagements; there is deliberately no such
   * route in this API yet (see the PR description).
   *
   * `@NoTransactionScope()`, same chicken-and-egg reason as `cryptoShred`
   * above: this handler is itself replacing the crypto material the
   * interceptor's `withEngagement` would otherwise unwrap up front.
   *
   * Authz mirrors `cryptoShred`/`addMember`: engagement-admin or tenant-admin,
   * checked before any DB or KMS work.
   *
   * Submitting is itself the verification step: a syntactically valid ARN
   * whose cross-account grant hasn't been set up (or hasn't propagated, or is
   * in the wrong region) fails the KMS `Encrypt` call inside
   * `rotateEngagementKey`, which fails closed — the engagement's previous key
   * is left completely untouched — and this handler turns that into a 400
   * with the upstream detail, rather than a 500 or a silently-broken
   * engagement.
   */
  @Post(':id/crypto/byok-key')
  @HttpCode(200)
  @NoTransactionScope()
  async setByokKey(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: SetByokKeyBody,
    @Req() req: AuthedRequest,
  ): Promise<SetByokKeyResponse> {
    const session = req.fdeSession;
    if (!session) throw new UnauthorizedException('authentication required');
    const engagementId = id as EngagementId;
    const { tenantId, userId } = session;

    // Authorize before doing any work or echoing validation detail back.
    const allowed =
      (await this.authz.canAdministerEngagement(userId, engagementId)) ||
      (await this.authz.canAdministerTenant(userId, tenantId));
    if (!allowed) throw new ForbiddenException("not authorized to manage this engagement's keys");

    const { byokKeyArn } = parseSetByokKeyBody(body);

    // Tenant-scoped existence check — same 404-on-cross-tenant convention as
    // `cryptoShred` above.
    const [exists] = await withTenant(this.db, tenantId, (tx) =>
      tx.select({ id: engagements.id }).from(engagements).where(eq(engagements.id, engagementId)),
    );
    if (!exists) throw new NotFoundException('engagement not found');

    try {
      await rotateEngagementKey(this.db, this.keyProvider, {
        tenantId,
        engagementId,
        actorId: userId,
        byokKeyArn,
      });
    } catch (err) {
      if (err instanceof EngagementShreddedError) {
        throw new GoneException('engagement is crypto-shredded');
      }
      const detail = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(
        `could not rewrap this engagement's key under the supplied ARN — confirm the cross-account KMS grant permits Decrypt and Encrypt for this platform's principal, and that the key is in the expected region (${detail})`,
      );
    }

    return { ok: true, byokKeyArn };
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// arn:aws:kms:<region>:<account-id>:key/<id> or :alias/<name> — also accepts
// the aws-us-gov / aws-cn partitions. Format-only; a well-formed but
// nonexistent/inaccessible key still fails later, at the KMS call itself.
const KMS_KEY_ARN = /^arn:aws(?:-[a-z]+)*:kms:[a-z0-9-]+:\d{12}:(key\/[\w-]+|alias\/[\w/-]+)$/;

/** Shape-check the `POST /engagements/:id/crypto/byok-key` body. Throws 400 on anything off — including a malformed ARN, before any KMS call is made. */
function parseSetByokKeyBody(body: unknown): { byokKeyArn: string } {
  if (typeof body !== 'object' || body === null) {
    throw new BadRequestException('request body is required');
  }
  const { byokKeyArn } = body as Record<string, unknown>;
  if (typeof byokKeyArn !== 'string' || !KMS_KEY_ARN.test(byokKeyArn)) {
    throw new BadRequestException(
      'byokKeyArn must be a KMS key ARN, e.g. arn:aws:kms:us-east-1:111122223333:key/1234abcd-...',
    );
  }
  return { byokKeyArn };
}

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

/** Shape-check the `POST /engagements/:id/crypto-shred` body. Throws 400 on anything off. */
function parseCryptoShredBody(body: unknown): { reason: string } {
  if (typeof body !== 'object' || body === null) {
    throw new BadRequestException('request body is required');
  }
  const { reason } = body as Record<string, unknown>;
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new BadRequestException('reason must be a non-empty string');
  }
  return { reason };
}

/**
 * Shape-check `AgenticQaBody.history` — absent entirely is fine (a fresh
 * conversation); anything present must be an array of `{role, content}`
 * turns. Throws 400 on anything off, same posture as `question` itself:
 * malformed input is rejected here rather than silently dropped or coerced.
 */
function parseQaHistory(history: unknown): ChatMessage[] {
  if (history === undefined) return [];
  if (!Array.isArray(history)) {
    throw new BadRequestException('history must be an array');
  }
  return history.map((turn, i) => {
    if (typeof turn !== 'object' || turn === null) {
      throw new BadRequestException(`history[${i}] must be an object`);
    }
    const { role, content } = turn as Record<string, unknown>;
    if (role !== 'user' && role !== 'assistant') {
      throw new BadRequestException(`history[${i}].role must be "user" or "assistant"`);
    }
    if (typeof content !== 'string' || content.trim() === '') {
      throw new BadRequestException(`history[${i}].content must be a non-empty string`);
    }
    return { role, content };
  });
}
