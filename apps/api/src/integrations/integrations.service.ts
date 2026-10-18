import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthzClient } from '@fde/authz';
import {
  customIntegrationMappingSchema,
  normalizeCustomArtifact,
  type CanonicalRecord,
  type CustomIntegrationMapping,
  type CustomMappingIssue,
  type EngagementId,
  type TenantId,
  type UserId,
} from '@fde/core';
import {
  deleteCustomIntegration,
  insertCustomIntegration,
  rotateCustomIntegrationSecret,
  selectCustomIntegrationByIdForEngagement,
  selectCustomIntegrations,
  updateCustomIntegration,
  type CustomIntegrationRow,
} from '@fde/db';
import { getEngagementContext, getRequestContext } from '@fde/request-context';
import { z } from 'zod';

import type { Env } from '../config/env.js';
import { CustomIntegrationSecretService } from './custom-integration-secret.service.js';

export interface CustomIntegrationView {
  id: string;
  name: string;
  enabled: boolean;
  mapping: CustomIntegrationMapping;
  /** display-only fingerprint — never the secret */
  secretPrefix: string;
  secretSetAt: string;
  lastIngestedAt: string | null;
  createdAt: string;
  updatedAt: string;
  ingestUrl: string;
}

/** Returned once, on create / rotate. `secret` is never retrievable afterwards. */
export interface CustomIntegrationWithSecret extends CustomIntegrationView {
  secret: string;
}

export interface TestMappingResult {
  records: CanonicalRecord[];
  issues: CustomMappingIssue[];
}

const nameSchema = z.string().trim().min(1).max(100);
const createBodySchema = z.object({ name: nameSchema, mapping: z.unknown() });
const updateBodySchema = z.object({
  name: nameSchema.optional(),
  enabled: z.boolean().optional(),
  mapping: z.unknown().optional(),
});
const testBodySchema = z.object({ mapping: z.unknown(), payload: z.unknown() });

function badBody(err: z.ZodError): never {
  throw new BadRequestException(
    err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
  );
}

export function parseMapping(raw: unknown): CustomIntegrationMapping {
  const r = customIntegrationMappingSchema.safeParse(raw);
  if (!r.success) {
    throw new UnprocessableEntityException({
      message: 'invalid mapping',
      issues: r.error.issues.map((i) => ({ at: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

/**
 * Admin CRUD for self-serve custom integrations. Reads `tx` from
 * `getRequestContext()` (the engagement transaction opened for
 * `@EngagementScope`); every `@fde/db` helper additionally filters
 * tenant + engagement by hand because `custom_integrations` has no RLS.
 * Every route is admin-only and always enforced (the mapping decides what an
 * external caller can write into the graph).
 */
@Injectable()
export class IntegrationsService {
  private readonly publicUrl: string;

  constructor(
    @Inject(AuthzClient) private readonly authz: AuthzClient,
    @Inject(CustomIntegrationSecretService)
    private readonly secrets: CustomIntegrationSecretService,
    @Inject(ConfigService) config: ConfigService<Env, true>,
  ) {
    this.publicUrl = config.get('API_PUBLIC_URL', { infer: true }).replace(/\/+$/, '');
  }

  async list(): Promise<CustomIntegrationView[]> {
    const { tx, tenantId } = await this.admin();
    const rows = await selectCustomIntegrations(tx, tenantId, getEngagementContext().id);
    return rows.map((r) => this.view(r));
  }

  async get(id: string): Promise<CustomIntegrationView> {
    const { tx, tenantId } = await this.admin();
    const row = await selectCustomIntegrationByIdForEngagement(
      tx,
      tenantId,
      getEngagementContext().id,
      id,
    );
    if (!row) throw new NotFoundException('integration not found');
    return this.view(row);
  }

  async create(body: unknown): Promise<CustomIntegrationWithSecret> {
    const { tx, tenantId, userId } = await this.admin();
    const parsed = createBodySchema.safeParse(body);
    if (!parsed.success) badBody(parsed.error);
    const mapping = parseMapping(parsed.data.mapping);
    const secret = this.secrets.generate();
    const row = await insertCustomIntegration(tx, {
      tenantId,
      engagementId: getEngagementContext().id,
      name: parsed.data.name,
      mapping,
      secretHash: secret.hashHex,
      secretPrefix: secret.prefix,
      createdByUserId: userId,
    });
    return { ...this.view(row), secret: secret.raw };
  }

  async update(id: string, body: unknown): Promise<CustomIntegrationView> {
    const { tx, tenantId } = await this.admin();
    const parsed = updateBodySchema.safeParse(body);
    if (!parsed.success) badBody(parsed.error);
    const patch: { name?: string; enabled?: boolean; mapping?: CustomIntegrationMapping } = {};
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.enabled !== undefined) patch.enabled = parsed.data.enabled;
    if (parsed.data.mapping !== undefined) patch.mapping = parseMapping(parsed.data.mapping);
    const row = await updateCustomIntegration(tx, tenantId, getEngagementContext().id, id, patch);
    if (!row) throw new NotFoundException('integration not found');
    return this.view(row);
  }

  async remove(id: string): Promise<void> {
    const { tx, tenantId } = await this.admin();
    const removed = await deleteCustomIntegration(tx, tenantId, getEngagementContext().id, id);
    if (!removed) throw new NotFoundException('integration not found');
  }

  async rotateSecret(id: string): Promise<CustomIntegrationWithSecret> {
    const { tx, tenantId } = await this.admin();
    const secret = this.secrets.generate();
    const row = await rotateCustomIntegrationSecret(tx, tenantId, getEngagementContext().id, id, {
      secretHash: secret.hashHex,
      secretPrefix: secret.prefix,
    });
    if (!row) throw new NotFoundException('integration not found');
    return { ...this.view(row), secret: secret.raw };
  }

  /**
   * Pure dry-run of an (possibly unsaved) mapping against a sample payload.
   * Touches no `custom_integrations` row. Non-strict, so a half-wrong mapping
   * still reports what did resolve alongside what didn't.
   */
  async test(body: unknown): Promise<TestMappingResult> {
    await this.admin();
    const parsed = testBodySchema.safeParse(body);
    if (!parsed.success) badBody(parsed.error);
    const mapping = parseMapping(parsed.data.mapping);
    return normalizeCustomArtifact(mapping, 'custom:test', parsed.data.payload, { strict: false });
  }

  // --- internals ---------------------------------------------------------

  private view(r: CustomIntegrationRow): CustomIntegrationView {
    return {
      id: r.id,
      name: r.name,
      enabled: r.enabled,
      mapping: r.mapping,
      secretPrefix: r.secretPrefix,
      secretSetAt: r.secretSetAt.toISOString(),
      lastIngestedAt: r.lastIngestedAt ? r.lastIngestedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      ingestUrl: `${this.publicUrl}/engagements/${r.engagementId}/integrations/${r.id}/ingest`,
    };
  }

  /** Same gate as `AdminService.assertCanAdminister`; returns the request context. */
  private async admin() {
    const ctx = getRequestContext();
    await this.assertCanAdminister(ctx.userId, ctx.tenantId, getEngagementContext().id);
    return ctx;
  }

  private async assertCanAdminister(
    userId: UserId,
    tenantId: TenantId,
    engagementId: EngagementId,
  ): Promise<void> {
    await this.authz.linkEngagementToTenant(engagementId, tenantId);
    const allowed =
      (await this.authz.canAdministerEngagement(userId, engagementId)) ||
      (await this.authz.canAdministerTenant(userId, tenantId));
    if (!allowed) {
      throw new ForbiddenException('not authorized to administer this engagement');
    }
  }
}
