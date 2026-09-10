import { and, eq } from 'drizzle-orm';

import type { Ciphertext, EngagementId, RetentionPolicy, TenantId } from '@fde/core';

import type { DbTransaction } from './client.js';
import { connectorConfig } from './schema/connector-config.js';
import { connectorSyncState } from './schema/connector-sync.js';
import { engagements } from './schema/tenancy.js';

/**
 * `connector_config` / `connector_sync_state` access for the `/admin` connector
 * API. Same contract as `retrieval.ts`: every function takes the caller's
 * already-open `withTenant` / `withEngagement` transaction and pins both
 * `tenant_id` and `engagement_id` (RLS + explicit predicate, defence in depth).
 * `credential_ref` is returned as ciphertext — the API never decrypts it, it
 * only reports presence.
 */

/** The engagement's own `retention_policy` — the base for `effectiveRetention`. */
export async function selectEngagementRetentionPolicy(
  tx: DbTransaction,
  tenantId: TenantId,
  engagementId: EngagementId,
): Promise<RetentionPolicy | undefined> {
  const [row] = await tx
    .select({ retentionPolicy: engagements.retentionPolicy })
    .from(engagements)
    .where(and(eq(engagements.tenantId, tenantId), eq(engagements.id, engagementId)))
    .limit(1);
  return row?.retentionPolicy;
}

export interface ConnectorConfigRow {
  connector: string;
  enabled: boolean;
  retentionOverride: RetentionPolicy | null;
  credentialRef: Ciphertext | null;
  updatedAt: Date;
}

/** Every `connector_config` row for one engagement (encrypted `credentialRef` as-is). */
export function selectConnectorConfigs(
  tx: DbTransaction,
  tenantId: TenantId,
  engagementId: EngagementId,
): Promise<ConnectorConfigRow[]> {
  return tx
    .select({
      connector: connectorConfig.connector,
      enabled: connectorConfig.enabled,
      retentionOverride: connectorConfig.retentionOverride,
      credentialRef: connectorConfig.credentialRef,
      updatedAt: connectorConfig.updatedAt,
    })
    .from(connectorConfig)
    .where(
      and(eq(connectorConfig.tenantId, tenantId), eq(connectorConfig.engagementId, engagementId)),
    );
}

export interface ConnectorSyncStateRow {
  connector: string;
  status: 'idle' | 'running' | 'error';
  cursor: string | null;
  lastRunAt: Date | null;
  updatedAt: Date;
}

/** Every `connector_sync_state` row for one engagement. */
export function selectConnectorSyncStates(
  tx: DbTransaction,
  tenantId: TenantId,
  engagementId: EngagementId,
): Promise<ConnectorSyncStateRow[]> {
  return tx
    .select({
      connector: connectorSyncState.connector,
      status: connectorSyncState.status,
      cursor: connectorSyncState.cursor,
      lastRunAt: connectorSyncState.lastRunAt,
      updatedAt: connectorSyncState.updatedAt,
    })
    .from(connectorSyncState)
    .where(
      and(
        eq(connectorSyncState.tenantId, tenantId),
        eq(connectorSyncState.engagementId, engagementId),
      ),
    );
}

export interface ConnectorConfigPatch {
  enabled?: boolean;
  /** `null` clears the override (inherit the engagement policy) */
  retentionOverride?: RetentionPolicy | null;
  /** already-encrypted; `null` clears the stored credential */
  credentialRef?: Ciphertext | null;
}

/**
 * Upsert one `(engagement, connector)` config row. Only the keys present in
 * `patch` are written on conflict, so a `PUT` that omits `credential` never
 * disturbs the stored secret.
 */
export async function upsertConnectorConfig(
  tx: DbTransaction,
  ref: { tenantId: TenantId; engagementId: EngagementId; connector: string },
  patch: ConnectorConfigPatch,
): Promise<void> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  if (patch.retentionOverride !== undefined) set.retentionOverride = patch.retentionOverride;
  if (patch.credentialRef !== undefined) set.credentialRef = patch.credentialRef;

  await tx
    .insert(connectorConfig)
    .values({
      tenantId: ref.tenantId,
      engagementId: ref.engagementId,
      connector: ref.connector,
      enabled: patch.enabled ?? false,
      retentionOverride: patch.retentionOverride ?? null,
      credentialRef: patch.credentialRef ?? null,
    })
    .onConflictDoUpdate({
      target: [connectorConfig.engagementId, connectorConfig.connector],
      set,
    });
}
