import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type EngagementId,
  RETENTION_POLICIES,
  type RetentionPolicy,
  type TenantId,
  type UserId,
} from '@fde/core';
import { AuthzClient } from '@fde/authz';
import { ConnectorRegistry } from '@fde/connectors';
import { encryptRow } from '@fde/crypto';
import {
  type ConnectorConfigPatch,
  CRYPTO_COLUMNS,
  selectConnectorConfigs,
  selectConnectorSyncStates,
  selectEngagementRetentionPolicy,
  upsertConnectorConfig,
} from '@fde/db';

import type { Env } from '../config/env.js';
import { getEngagementContext, getRequestContext } from '../request-context/request-context.js';
import { TemporalConnectorSync } from '../temporal/temporal.module.js';
import { CONNECTOR_REGISTRY } from './admin.tokens.js';

export interface ConnectorSyncView {
  status: 'idle' | 'running' | 'error' | null;
  lastRunAt: string | null;
  cursorPresent: boolean;
}

export interface ConnectorView {
  connector: string;
  authKind: string;
  enabled: boolean;
  effectiveRetention: RetentionPolicy;
  hasCredential: boolean;
  sync: ConnectorSyncView;
}

export interface PutConnectorInput {
  enabled?: boolean;
  /** `null` clears the override */
  retentionOverride?: RetentionPolicy | null;
  /** cleartext secret — encrypted before it touches the DB, never returned */
  credential?: string;
  /** true when the request body carried a `retentionOverride` key at all */
  retentionOverrideProvided: boolean;
}

/**
 * The `/admin` connector-configuration surface. Same seam discipline as
 * `RetrievalService`: holds no DB code of its own, reads `tx` from
 * `getRequestContext()` (the engagement transaction the interceptor opened for
 * `@EngagementScope`), and hands it to the `@fde/db` helpers. Reads are
 * `canViewEngagement`-gated under `AUTHZ_ENFORCE`; mutations
 * (`putConnector` / `startSync`) are admin-only and always enforced.
 */
@Injectable()
export class AdminService {
  private readonly enforce: boolean;

  constructor(
    @Inject(CONNECTOR_REGISTRY) private readonly registry: ConnectorRegistry,
    @Inject(AuthzClient) private readonly authz: AuthzClient,
    @Inject(TemporalConnectorSync) private readonly temporal: TemporalConnectorSync,
    @Inject(ConfigService) config: ConfigService<Env, true>,
  ) {
    this.enforce = config.get('AUTHZ_ENFORCE', { infer: true }) === 'true';
  }

  /** Registry × `connector_config` × `connector_sync_state`, one row per registered connector. */
  async listConnectors(): Promise<ConnectorView[]> {
    const { userId, tenantId } = getRequestContext();
    const engagement = getEngagementContext();
    await this.assertCanView(userId, tenantId, engagement.id);
    return this.buildViews();
  }

  /** Upsert one `(engagement, connector)` config row. Admin-only. Never echoes the credential. */
  async putConnector(connectorId: string, input: PutConnectorInput): Promise<ConnectorView> {
    const { tx, userId, tenantId } = getRequestContext();
    const engagement = getEngagementContext();
    await this.assertCanAdminister(userId, tenantId, engagement.id);

    if (!this.registry.has(connectorId)) {
      throw new BadRequestException(`unknown connector: ${connectorId}`);
    }

    const patch: ConnectorConfigPatch = {};
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (input.retentionOverrideProvided) patch.retentionOverride = input.retentionOverride ?? null;
    if (input.credential !== undefined) {
      const { credentialRef } = await encryptRow(
        engagement.cipher,
        CRYPTO_COLUMNS.connector_config,
        {
          credentialRef: input.credential,
        },
      );
      patch.credentialRef = credentialRef;
    }

    await upsertConnectorConfig(
      tx,
      { tenantId, engagementId: engagement.id, connector: connectorId },
      patch,
    );

    const view = (await this.buildViews()).find((c) => c.connector === connectorId);
    // registry.has() passed above, so the row is always in the list.
    return view!;
  }

  /** Start `connectorSyncWorkflow` for one connector. Admin-only. */
  async startSync(
    connectorId: string,
    mode: 'backfill' | 'incremental',
  ): Promise<{ workflowId: string }> {
    const { tx, userId, tenantId } = getRequestContext();
    const engagement = getEngagementContext();
    await this.assertCanAdminister(userId, tenantId, engagement.id);

    if (!this.registry.has(connectorId)) {
      throw new BadRequestException(`unknown connector: ${connectorId}`);
    }

    const cfg = (await selectConnectorConfigs(tx, tenantId, engagement.id)).find(
      (c) => c.connector === connectorId,
    );
    if (!cfg?.enabled) {
      throw new ConflictException(`connector ${connectorId} is not enabled for this engagement`);
    }
    if (cfg.credentialRef == null) {
      throw new ConflictException(`connector ${connectorId} has no stored credential`);
    }

    // 503 (Temporal unconfigured or unreachable) is raised inside the gateway.
    return this.temporal.start({
      tenantId,
      engagementId: engagement.id,
      connectorId,
      mode,
    });
  }

  // --- internals ---------------------------------------------------------

  /** Merge registry + `connector_config` + `connector_sync_state` into the response rows. */
  private async buildViews(): Promise<ConnectorView[]> {
    const { tx, tenantId } = getRequestContext();
    const engagement = getEngagementContext();
    const basePolicy =
      (await selectEngagementRetentionPolicy(tx, tenantId, engagement.id)) ?? 'full-retention';
    const configs = new Map(
      (await selectConnectorConfigs(tx, tenantId, engagement.id)).map((c) => [c.connector, c]),
    );
    const states = new Map(
      (await selectConnectorSyncStates(tx, tenantId, engagement.id)).map((s) => [s.connector, s]),
    );
    return [...this.registry.ids].sort().map((id) => {
      const cfg = configs.get(id);
      const state = states.get(id);
      const policy = cfg?.retentionOverride ?? basePolicy;
      const connector = this.registry.build(id, { engagementRetentionPolicy: policy });
      return {
        connector: id,
        authKind: connector.authKind,
        enabled: cfg?.enabled ?? false,
        effectiveRetention: connector.retentionPolicy,
        hasCredential: cfg?.credentialRef != null,
        sync: {
          status: state?.status ?? null,
          lastRunAt: state?.lastRunAt ? state.lastRunAt.toISOString() : null,
          cursorPresent: state?.cursor != null,
        },
      };
    });
  }

  private async assertCanView(
    userId: UserId,
    tenantId: TenantId,
    engagementId: EngagementId,
  ): Promise<void> {
    if (!this.enforce) return;
    await this.authz.linkEngagementToTenant(engagementId, tenantId);
    if (!(await this.authz.canViewEngagement(userId, engagementId))) {
      throw new ForbiddenException('not authorized to view this engagement');
    }
  }

  private async assertCanAdminister(
    userId: UserId,
    tenantId: TenantId,
    engagementId: EngagementId,
  ): Promise<void> {
    // Always enforced — this mutates connector configuration. Mirrors
    // `EngagementsController.addMember`.
    await this.authz.linkEngagementToTenant(engagementId, tenantId);
    const allowed =
      (await this.authz.canAdministerEngagement(userId, engagementId)) ||
      (await this.authz.canAdministerTenant(userId, tenantId));
    if (!allowed) {
      throw new ForbiddenException('not authorized to administer this engagement');
    }
  }
}

/** Parse the `PUT …/connectors/:connectorId` body. Throws 400 on anything off. */
export function parsePutConnectorBody(body: unknown): PutConnectorInput {
  if (typeof body !== 'object' || body === null) {
    throw new BadRequestException('request body is required');
  }
  const b = body as Record<string, unknown>;
  const out: PutConnectorInput = { retentionOverrideProvided: 'retentionOverride' in b };

  if (b.enabled !== undefined) {
    if (typeof b.enabled !== 'boolean') throw new BadRequestException('enabled must be a boolean');
    out.enabled = b.enabled;
  }
  if (out.retentionOverrideProvided) {
    const ro = b.retentionOverride;
    if (ro !== null && !(RETENTION_POLICIES as readonly unknown[]).includes(ro)) {
      throw new BadRequestException(
        `retentionOverride must be null or one of: ${RETENTION_POLICIES.join(', ')}`,
      );
    }
    out.retentionOverride = ro as RetentionPolicy | null;
  }
  if (b.credential !== undefined) {
    if (typeof b.credential !== 'string' || b.credential.trim() === '') {
      throw new BadRequestException('credential must be a non-empty string');
    }
    out.credential = b.credential;
  }
  return out;
}

/** Parse the `POST …/connectors/:connectorId/sync` body. */
export function parseSyncBody(body: unknown): { mode: 'backfill' | 'incremental' } {
  const mode = (body as { mode?: unknown } | null)?.mode;
  if (mode !== 'backfill' && mode !== 'incremental') {
    throw new BadRequestException("mode must be 'backfill' or 'incremental'");
  }
  return { mode };
}
