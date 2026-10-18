import type { CustomIntegrationMapping, EngagementId, TenantId } from '@fde/core';
import { and, eq } from 'drizzle-orm';

import type { Database, DbTransaction } from './client.js';
import { customIntegrations } from './schema/custom-integrations.js';

/**
 * `custom_integrations` access.
 *
 * !! `custom_integrations` has NO row-level security (see
 * `schema/custom-integrations.ts` for why: the public ingest endpoint resolves
 * a row before any tenant is known). Nothing in the database scopes these
 * queries, so every helper below that is not named `...Bare` MUST — and does —
 * filter `tenant_id` AND `engagement_id` explicitly. Never look a row up by a
 * bare `id` on an authenticated path: an `id` from another tenant would match.
 *
 * Works on a plain `Database` or an already-open transaction.
 */
type Db = Database | DbTransaction;

export interface CustomIntegrationRow {
  id: string;
  tenantId: TenantId;
  engagementId: EngagementId;
  name: string;
  enabled: boolean;
  mapping: CustomIntegrationMapping;
  secretHash: string;
  secretPrefix: string;
  secretSetAt: Date;
  lastIngestedAt: Date | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const asRow = (r: unknown) => r as CustomIntegrationRow;

const scope = (tenantId: TenantId, engagementId: EngagementId) =>
  and(eq(customIntegrations.tenantId, tenantId), eq(customIntegrations.engagementId, engagementId));

export async function insertCustomIntegration(
  db: Db,
  input: {
    tenantId: TenantId;
    engagementId: EngagementId;
    name: string;
    mapping: CustomIntegrationMapping;
    secretHash: string;
    secretPrefix: string;
    createdByUserId: string | null;
  },
): Promise<CustomIntegrationRow> {
  const [row] = await db.insert(customIntegrations).values(input).returning();
  return asRow(row);
}

export async function selectCustomIntegrations(
  db: Db,
  tenantId: TenantId,
  engagementId: EngagementId,
): Promise<CustomIntegrationRow[]> {
  const rows = await db
    .select()
    .from(customIntegrations)
    .where(scope(tenantId, engagementId))
    .orderBy(customIntegrations.createdAt);
  return rows.map(asRow);
}

export async function selectCustomIntegrationByIdForEngagement(
  db: Db,
  tenantId: TenantId,
  engagementId: EngagementId,
  id: string,
): Promise<CustomIntegrationRow | undefined> {
  const [row] = await db
    .select()
    .from(customIntegrations)
    .where(and(scope(tenantId, engagementId), eq(customIntegrations.id, id)))
    .limit(1);
  return row ? asRow(row) : undefined;
}

export async function updateCustomIntegration(
  db: Db,
  tenantId: TenantId,
  engagementId: EngagementId,
  id: string,
  patch: { name?: string; enabled?: boolean; mapping?: CustomIntegrationMapping },
): Promise<CustomIntegrationRow | undefined> {
  const [row] = await db
    .update(customIntegrations)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(scope(tenantId, engagementId), eq(customIntegrations.id, id)))
    .returning();
  return row ? asRow(row) : undefined;
}

/** Overwrites the hash — the old secret stops working immediately. */
export async function rotateCustomIntegrationSecret(
  db: Db,
  tenantId: TenantId,
  engagementId: EngagementId,
  id: string,
  next: { secretHash: string; secretPrefix: string },
): Promise<CustomIntegrationRow | undefined> {
  const now = new Date();
  const [row] = await db
    .update(customIntegrations)
    .set({ ...next, secretSetAt: now, updatedAt: now })
    .where(and(scope(tenantId, engagementId), eq(customIntegrations.id, id)))
    .returning();
  return row ? asRow(row) : undefined;
}

/** True when a row was removed. */
export async function deleteCustomIntegration(
  db: Db,
  tenantId: TenantId,
  engagementId: EngagementId,
  id: string,
): Promise<boolean> {
  const rows = await db
    .delete(customIntegrations)
    .where(and(scope(tenantId, engagementId), eq(customIntegrations.id, id)))
    .returning({ id: customIntegrations.id });
  return rows.length > 0;
}

/**
 * Pre-tenant lookup for the public ingest endpoint ONLY. No tenant filter by
 * design — the caller must check `row.engagementId` against the URL and verify
 * the secret before trusting anything on the row.
 */
export async function selectCustomIntegrationByIdBare(
  db: Db,
  id: string,
): Promise<CustomIntegrationRow | undefined> {
  const [row] = await db
    .select()
    .from(customIntegrations)
    .where(eq(customIntegrations.id, id))
    .limit(1);
  return row ? asRow(row) : undefined;
}

/** Ingest controller only; best-effort bookkeeping after a successful landing. */
export async function touchCustomIntegrationLastIngestedAt(db: Db, id: string): Promise<void> {
  await db
    .update(customIntegrations)
    .set({ lastIngestedAt: new Date() })
    .where(eq(customIntegrations.id, id));
}
