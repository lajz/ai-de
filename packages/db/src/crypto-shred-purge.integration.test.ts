import { randomUUID } from 'node:crypto';

import type { EngagementId, TenantId } from '@fde/core';
import { FakeKeyProvider, getCipher } from '@fde/crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDbClient, type Database } from './client.js';
import { purgeEngagementCiphertext } from './crypto-shred-purge.js';
import { withEngagement } from './engagement.js';
import { withTenant } from './rls.js';
import {
  aclSnapshots,
  connectorConfig,
  entities,
  evidence,
  facts,
  sources,
  engagements,
  tenants,
} from './schema/index.js';

// Integration test — needs a migrated + hardened database. Skipped unless
// DATABASE_URL is set:
//   docker compose up -d postgres && pnpm db:bootstrap && pnpm db:migrate && pnpm db:harden
//   DATABASE_URL=postgres://postgres:postgres@localhost:5433/fde_dev pnpm test
const url = process.env.DATABASE_URL;

describe.skipIf(!url)('purgeEngagementCiphertext', () => {
  const provider = new FakeKeyProvider();
  let handle: { db: Database; close: () => Promise<void> };
  const tenantId = randomUUID() as TenantId;

  async function seedEngagement(): Promise<EngagementId> {
    const engagementId = randomUUID() as EngagementId;
    const { wrappedDek } = await provider.generateDek({
      tenantId,
      engagementId,
      tenantCmkArn: 'fake:cmk',
    });
    await handle.db.insert(engagements).values({
      id: engagementId,
      tenantId,
      endCustomerName: `Acme ${engagementId.slice(0, 8)}`,
      regionPin: 'us',
      retentionPolicy: 'full-retention',
      wrappedDek: Buffer.from(wrappedDek).toString('base64'),
    });
    return engagementId;
  }

  /** Seeds one row in every engagement-scoped 🔒 table, all real (non-empty) ciphertext. */
  async function seedCiphertextRows(engagementId: EngagementId) {
    return withEngagement(handle.db, provider, { tenantId, engagementId }, async (tx) => {
      const sourceId = randomUUID();
      await tx.insert(sources).values({
        id: sourceId,
        tenantId,
        engagementId,
        connector: 'granola',
        externalId: `ext-${sourceId.slice(0, 8)}`,
        kind: 'transcript',
        occurredAt: new Date('2026-09-01T00:00:00.000Z'),
        contentHash: sourceId,
        retentionPolicy: 'full-retention',
        rawBody: await getCipher().encryptString('sources.raw_body', 'raw transcript text'),
      });

      const aclId = randomUUID();
      await tx.insert(aclSnapshots).values({
        id: aclId,
        tenantId,
        engagementId,
        sourceRef: `granola:ext-${sourceId.slice(0, 8)}`,
        principalRules: await getCipher().encryptJson('acl_snapshots.principal_rules', [
          { kind: 'user', id: 'u1' },
        ]),
        capturedAt: new Date('2026-09-01T00:00:00.000Z'),
        ttlSeconds: 3600,
      });
      await tx.update(sources).set({ aclSnapshotId: aclId }).where(eq(sources.id, sourceId));

      const factId = randomUUID();
      await tx.insert(facts).values({
        id: factId,
        tenantId,
        engagementId,
        type: 'decision',
        summary: 'chose postgres',
        body: await getCipher().encryptString('facts.body', 'the full decision detail'),
      });

      const evidenceId = randomUUID();
      await tx.insert(evidence).values({
        id: evidenceId,
        tenantId,
        engagementId,
        factId,
        sourceId,
        quote: await getCipher().encryptString('evidence.quote', 'we chose postgres'),
      });

      const entityId = randomUUID();
      await tx.insert(entities).values({
        id: entityId,
        tenantId,
        engagementId,
        type: 'work_item',
        displayName: 'ENG-1',
        attributes: await getCipher().encryptJson('entities.attributes', { note: 'secret' }),
        body: await getCipher().encryptString('entities.body', 'entity body text'),
      });

      await tx.insert(connectorConfig).values({
        id: randomUUID(),
        tenantId,
        engagementId,
        connector: 'granola',
        enabled: true,
        credentialRef: await getCipher().encryptString(
          'connector_config.credential_ref',
          'grn_supersecret',
        ),
      });

      return { sourceId, aclId, factId, evidenceId, entityId };
    });
  }

  /** Raw bytea lengths for every 🔒 column, bypassing the crypto layer entirely. */
  async function cipherLengths(
    engagementId: EngagementId,
    ids: Awaited<ReturnType<typeof seedCiphertextRows>>,
  ) {
    const [row] = await handle.db.execute<{
      fact_body: number | null;
      evidence_quote: number | null;
      source_raw_body: number | null;
      acl_principal_rules: number;
      entity_attributes: number;
      entity_body: number | null;
      connector_credential_ref: number | null;
    }>(sql`
      select
        (select length(body) from facts where id = ${ids.factId}) as fact_body,
        (select length(quote) from evidence where id = ${ids.evidenceId}) as evidence_quote,
        (select length(raw_body) from sources where id = ${ids.sourceId}) as source_raw_body,
        (select length(principal_rules) from acl_snapshots where id = ${ids.aclId}) as acl_principal_rules,
        (select length(attributes) from entities where id = ${ids.entityId}) as entity_attributes,
        (select length(body) from entities where id = ${ids.entityId}) as entity_body,
        (select length(credential_ref) from connector_config where engagement_id = ${engagementId}) as connector_credential_ref
    `);
    return row!;
  }

  beforeAll(async () => {
    handle = createDbClient({ url: url!, max: 1 });
    await handle.db.insert(tenants).values({ id: tenantId, name: 'T', cmkKeyRef: 'fake:cmk' });
  });

  afterAll(async () => {
    await handle.db.delete(engagements).where(eq(engagements.tenantId, tenantId));
    await handle.close();
  });

  it('nulls (or blanks NOT NULL columns to empty ciphertext) every registered 🔒 column for the engagement', async () => {
    const engagementId = await seedEngagement();
    const ids = await seedCiphertextRows(engagementId);

    const before = await cipherLengths(engagementId, ids);
    expect(before.fact_body).toBeGreaterThan(0);
    expect(before.evidence_quote).toBeGreaterThan(0);
    expect(before.source_raw_body).toBeGreaterThan(0);
    expect(before.acl_principal_rules).toBeGreaterThan(0);
    expect(before.entity_attributes).toBeGreaterThan(0);
    expect(before.entity_body).toBeGreaterThan(0);
    expect(before.connector_credential_ref).toBeGreaterThan(0);

    const result = await purgeEngagementCiphertext(handle.db, { tenantId, engagementId });
    expect(result.totalRowsPurged).toBe(6); // facts, evidence, sources, acl_snapshots, entities, connector_config — one row each
    expect(result.perTable).toMatchObject({
      facts: 1,
      evidence: 1,
      sources: 1,
      acl_snapshots: 1,
      entities: 1,
      connector_config: 1,
    });

    const after = await cipherLengths(engagementId, ids);
    expect(after.fact_body).toBeNull();
    expect(after.evidence_quote).toBeNull();
    expect(after.source_raw_body).toBeNull();
    expect(after.acl_principal_rules).toBe(0); // NOT NULL — blanked, not nulled
    expect(after.entity_attributes).toBe(0); // NOT NULL — blanked, not nulled
    expect(after.entity_body).toBeNull();
    expect(after.connector_credential_ref).toBeNull();
  });

  it('leaves a different engagement (including one in the same tenant) completely untouched', async () => {
    const shredded = await seedEngagement();
    const other = await seedEngagement();
    await seedCiphertextRows(shredded);
    const otherIds = await seedCiphertextRows(other);

    await purgeEngagementCiphertext(handle.db, { tenantId, engagementId: shredded });

    const otherAfter = await cipherLengths(other, otherIds);
    expect(otherAfter.fact_body).toBeGreaterThan(0);
    expect(otherAfter.evidence_quote).toBeGreaterThan(0);
    expect(otherAfter.source_raw_body).toBeGreaterThan(0);
    expect(otherAfter.acl_principal_rules).toBeGreaterThan(0);
    expect(otherAfter.entity_attributes).toBeGreaterThan(0);
    expect(otherAfter.entity_body).toBeGreaterThan(0);
    expect(otherAfter.connector_credential_ref).toBeGreaterThan(0);

    // still decryptable — the DEK was never touched, only a from-scratch purge
    // would ever run against an engagement that hasn't been shredded
    const plaintext = await withEngagement(
      handle.db,
      provider,
      { tenantId, engagementId: other },
      (tx) =>
        tx
          .select({ body: facts.body })
          .from(facts)
          .where(eq(facts.id, otherIds.factId))
          .then(([row]) => getCipher().decryptString('facts.body', row!.body!)),
    );
    expect(plaintext).toBe('the full decision detail');
  });

  it('is idempotent — a second run against an already-purged engagement does nothing', async () => {
    const engagementId = await seedEngagement();
    await seedCiphertextRows(engagementId);

    const first = await purgeEngagementCiphertext(handle.db, { tenantId, engagementId });
    expect(first.totalRowsPurged).toBe(6);

    const second = await purgeEngagementCiphertext(handle.db, { tenantId, engagementId });
    expect(second.totalRowsPurged).toBe(0);
    expect(second.perTable).toMatchObject({
      facts: 0,
      evidence: 0,
      sources: 0,
      acl_snapshots: 0,
      entities: 0,
      connector_config: 0,
    });
  });

  it('batches: a batchSize of 1 still purges every row across multiple batches', async () => {
    const engagementId = await seedEngagement();
    await withEngagement(handle.db, provider, { tenantId, engagementId }, async (tx) => {
      for (let i = 0; i < 3; i++) {
        await tx.insert(facts).values({
          id: randomUUID(),
          tenantId,
          engagementId,
          type: 'decision',
          summary: `d${i}`,
          body: await getCipher().encryptString('facts.body', `detail ${i}`),
        });
      }
    });

    const seen: number[] = [];
    const result = await purgeEngagementCiphertext(
      handle.db,
      { tenantId, engagementId },
      { batchSize: 1, onBatch: (p) => seen.push(p.purgedInBatch) },
    );
    expect(result.perTable.facts).toBe(3);
    expect(seen.filter((n) => n > 0)).toHaveLength(3);

    const rows = await withTenant(handle.db, tenantId, (tx) =>
      tx
        .select({ body: sql<Buffer | null>`${facts.body}` })
        .from(facts)
        .where(eq(facts.engagementId, engagementId)),
    );
    expect(rows.every((r) => r.body === null)).toBe(true);
  });
});
