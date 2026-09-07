import { randomUUID } from 'node:crypto';

import type { EngagementId, RetentionPolicy, TenantId } from '@fde/core';
import { FakeKeyProvider, getCipher } from '@fde/crypto';
import {
  captureSessions,
  createDbClient,
  engagements,
  sources,
  tenants,
  withEngagement,
  withTenant,
  type Database,
} from '@fde/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FakeRecallClient } from '../capture/index.js';
import { createCaptureSessionActivities } from './capture-session.js';

// Integration test — needs a migrated + hardened database, same convention as
// packages/db/src/engagement.test.ts:
//   docker compose up -d postgres && pnpm db:bootstrap && pnpm db:migrate && pnpm db:harden
//   DATABASE_URL=postgres://postgres:postgres@localhost:5433/fde_dev pnpm --filter @fde/workers test
const url = process.env.DATABASE_URL;

describe.skipIf(!url)('captureSession activities (integration)', () => {
  const provider = new FakeKeyProvider();
  let handle: { db: Database; close: () => Promise<void> };
  const tenantId = randomUUID() as TenantId;

  async function seedEngagement(retentionPolicy: RetentionPolicy): Promise<EngagementId> {
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
      retentionPolicy,
      wrappedDek: Buffer.from(wrappedDek).toString('base64'),
    });
    return engagementId;
  }

  function activities(recall = new FakeRecallClient({ pollsUntilDone: 1 })) {
    return createCaptureSessionActivities({
      db: handle.db,
      keyProvider: provider,
      recallClient: recall,
    });
  }

  async function capture(engagementId: EngagementId, retentionPolicy: RetentionPolicy) {
    const acts = activities();
    const captureSessionId = randomUUID();
    const common = {
      tenantId,
      engagementId,
      captureSessionId,
      meetingUrl: 'https://meet.example/room-42',
      joinAt: '2026-09-07T15:00:00.000Z',
      retentionPolicy,
    };
    const scheduled = await acts.scheduleCaptureBotActivity(common);
    const stored = await acts.storeTranscriptSourceActivity({ ...common, botId: scheduled.botId });
    return { captureSessionId, botId: scheduled.botId, stored };
  }

  beforeAll(async () => {
    handle = createDbClient({ url: url!, max: 1 });
    await handle.db.insert(tenants).values({ id: tenantId, name: 'T', cmkKeyRef: 'fake:cmk' });
  });

  afterAll(async () => {
    // dropping the engagements cascades to capture_sessions + sources
    await handle.db.delete(engagements).where(eq(engagements.tenantId, tenantId));
    await handle.close();
  });

  it('full-retention: the sources row is ciphertext at rest and decrypts through withEngagement', async () => {
    const engagementId = await seedEngagement('full-retention');
    const { captureSessionId, botId, stored } = await capture(engagementId, 'full-retention');

    expect(stored.bodyRetained).toBe(true);

    // direct read (bypasses the crypto mapper) — bytea ciphertext, not the words
    const [raw] = await handle.db
      .select({ rawBody: sources.rawBody })
      .from(sources)
      .where(eq(sources.id, stored.sourceId));
    expect(Buffer.from(raw!.rawBody!).toString('utf8')).not.toContain('Friday');

    // app path with the engagement DEK — round-trips to the transcript text
    const body = await withEngagement(
      handle.db,
      provider,
      { tenantId, engagementId },
      async (tx) => {
        const [row] = await tx
          .select({ rawBody: sources.rawBody })
          .from(sources)
          .where(eq(sources.id, stored.sourceId));
        return getCipher().decryptString('sources.raw_body', row!.rawBody!);
      },
    );
    expect(body).toContain('We decided to ship Friday.');

    // the capture_sessions row was advanced and linked
    const [cs] = await withTenant(handle.db, tenantId, (tx) =>
      tx
        .select({
          status: captureSessions.status,
          sourceId: captureSessions.sourceId,
          botId: captureSessions.botId,
        })
        .from(captureSessions)
        .where(eq(captureSessions.id, captureSessionId)),
    );
    expect(cs).toMatchObject({ status: 'captured', sourceId: stored.sourceId, botId });
  });

  it('derived-ephemeral-raw: stores the encrypted body + a purge_raw_after marker', async () => {
    const engagementId = await seedEngagement('derived-ephemeral-raw');
    const { captureSessionId, stored } = await capture(engagementId, 'derived-ephemeral-raw');
    expect(stored.bodyRetained).toBe(true);

    const [cs] = await withTenant(handle.db, tenantId, (tx) =>
      tx
        .select({ purgeRawAfter: captureSessions.purgeRawAfter })
        .from(captureSessions)
        .where(eq(captureSessions.id, captureSessionId)),
    );
    expect(cs!.purgeRawAfter).toBeInstanceOf(Date);
  });

  it('reference-only: no body is stored', async () => {
    const engagementId = await seedEngagement('reference-only');
    const { stored } = await capture(engagementId, 'reference-only');
    expect(stored.bodyRetained).toBe(false);

    const [row] = await handle.db
      .select({ rawBody: sources.rawBody, permalink: sources.urlPermalink })
      .from(sources)
      .where(eq(sources.id, stored.sourceId));
    expect(row!.rawBody).toBeNull();
    expect(row!.permalink).toBe('https://meet.example/room-42');
  });

  it('storeTranscriptSource is idempotent on a retry (dedupe hit)', async () => {
    const engagementId = await seedEngagement('full-retention');
    const acts = activities();
    const common = {
      tenantId,
      engagementId,
      captureSessionId: randomUUID(),
      meetingUrl: 'https://meet.example/room-42',
      joinAt: '2026-09-07T15:00:00.000Z',
      retentionPolicy: 'full-retention' as const,
    };
    const scheduled = await acts.scheduleCaptureBotActivity(common);
    const first = await acts.storeTranscriptSourceActivity({ ...common, botId: scheduled.botId });
    const second = await acts.storeTranscriptSourceActivity({ ...common, botId: scheduled.botId });
    expect(second.sourceId).toBe(first.sourceId);

    const rows = await withTenant(handle.db, tenantId, (tx) =>
      tx
        .select({ id: sources.id })
        .from(sources)
        .where(
          and(eq(sources.engagementId, engagementId), eq(sources.externalId, scheduled.botId)),
        ),
    );
    expect(rows).toHaveLength(1);
  });
});
