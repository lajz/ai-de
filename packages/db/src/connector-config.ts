import { and, eq } from 'drizzle-orm';

import type { Ciphertext, EngagementId, RetentionPolicy, TenantId } from '@fde/core';

import type { Database, DbTransaction } from './client.js';
import { connectorConfig } from './schema/connector-config.js';
import { connectorSyncState } from './schema/connector-sync.js';
import { engagements } from './schema/tenancy.js';

/** The `connector, external_scope_ref` partial unique index name — see `schema/connector-config.ts`. */
const SCOPE_CONFLICT_CONSTRAINT = 'connector_config_scope_uq';

/**
 * Raised when a `PUT` tries to claim an `external_scope_ref` another
 * `(tenant, engagement)` already owns for the same connector — the DB partial
 * unique index rejected the write. Callers (the `/admin` API) translate this
 * into a `409`; two concurrent `PUT`s racing to claim the same scope are both
 * safe, since the constraint — not an app-level pre-check — is what decides.
 */
export class ConnectorScopeConflictError extends Error {
  constructor(
    readonly connector: string,
    readonly externalScopeRef: string,
  ) {
    super(
      `connector_config: '${externalScopeRef}' is already claimed for connector '${connector}' by another engagement`,
    );
    this.name = 'ConnectorScopeConflictError';
  }
}

/** Structural check for a `postgres` driver unique-violation on our scope index — no `pg` type import needed. */
function isScopeConflict(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === '23505' &&
    (err as { constraint_name?: unknown }).constraint_name === SCOPE_CONFLICT_CONSTRAINT
  );
}

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
  externalScopeRef: string | null;
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
      externalScopeRef: connectorConfig.externalScopeRef,
      updatedAt: connectorConfig.updatedAt,
    })
    .from(connectorConfig)
    .where(
      and(eq(connectorConfig.tenantId, tenantId), eq(connectorConfig.engagementId, engagementId)),
    );
}

export interface ConnectorScopeMatch {
  tenantId: TenantId;
  engagementId: EngagementId;
}

/**
 * Maps a verified webhook payload's external scope key (a Linear organization
 * id today) to the `(tenant, engagement)` that claimed it — the lookup the
 * webhook receiver (`apps/api/src/webhooks`) needs before it has a tenant to
 * scope a normal `withTenant`/`withEngagement` transaction to.
 *
 * Deliberately a bare query, not `withTenant`: there is no tenant to scope it
 * to yet. It works only because of `connector_config_scope_lookup`
 * (`schema/connector-config.ts`) — a narrow RLS carve-out that makes a row with
 * a non-null `external_scope_ref` visible to a SELECT regardless of
 * `app.tenant_id`. Selects only the id columns; never `credential_ref`.
 */
export async function selectConnectorConfigByScopeRef(
  db: Database,
  connector: string,
  externalScopeRef: string,
): Promise<ConnectorScopeMatch | undefined> {
  const [row] = await db
    .select({
      tenantId: connectorConfig.tenantId,
      engagementId: connectorConfig.engagementId,
    })
    .from(connectorConfig)
    .where(
      and(
        eq(connectorConfig.connector, connector),
        eq(connectorConfig.externalScopeRef, externalScopeRef),
      ),
    )
    .limit(1);
  return row as ConnectorScopeMatch | undefined;
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
  /** `null` releases the claim; a non-null value must be globally unique per connector */
  externalScopeRef?: string | null;
}

/**
 * Upsert one `(engagement, connector)` config row. Only the keys present in
 * `patch` are written on conflict, so a `PUT` that omits `credential` never
 * disturbs the stored secret.
 *
 * @throws {ConnectorScopeConflictError} `patch.externalScopeRef` is already
 * claimed by a different `(tenant, engagement)` for this connector — the
 * `connector_config_scope_uq` partial unique index rejected the write. This is
 * the DB, not an app-level pre-check, so two concurrent `PUT`s racing to claim
 * the same scope both still resolve safely: exactly one wins.
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
  if (patch.externalScopeRef !== undefined) set.externalScopeRef = patch.externalScopeRef;

  try {
    await tx
      .insert(connectorConfig)
      .values({
        tenantId: ref.tenantId,
        engagementId: ref.engagementId,
        connector: ref.connector,
        enabled: patch.enabled ?? false,
        retentionOverride: patch.retentionOverride ?? null,
        credentialRef: patch.credentialRef ?? null,
        externalScopeRef: patch.externalScopeRef ?? null,
      })
      .onConflictDoUpdate({
        target: [connectorConfig.engagementId, connectorConfig.connector],
        set,
      });
  } catch (err) {
    if (isScopeConflict(err)) {
      throw new ConnectorScopeConflictError(ref.connector, patch.externalScopeRef ?? '');
    }
    throw err;
  }
}
