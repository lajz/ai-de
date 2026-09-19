import { randomUUID } from 'node:crypto';

import type { EngagementId, RawArtifact, TenantId } from '@fde/core';
import { createEngagementCipher, FakeKeyProvider, type EngagementCipher } from '@fde/crypto';
import { describe, expect, it } from 'vitest';

import { buildConnectorSource, connectorContentHash } from './connector-source.js';

const TENANT_CMK = 'fake:cmk';

async function newCipher(): Promise<{
  cipher: EngagementCipher;
  tenantId: TenantId;
  engagementId: EngagementId;
}> {
  const provider = new FakeKeyProvider();
  const tenantId = randomUUID() as TenantId;
  const engagementId = randomUUID() as EngagementId;
  const { wrappedDek } = await provider.generateDek({
    tenantId,
    engagementId,
    tenantCmkArn: TENANT_CMK,
  });
  const cipher = await createEngagementCipher(provider, {
    tenantId,
    engagementId,
    tenantCmkArn: TENANT_CMK,
    wrappedDek,
  });
  return { cipher, tenantId, engagementId };
}

const ARTIFACT: RawArtifact = {
  connector: 'granola',
  externalId: 'doc-1',
  kind: 'transcript',
  urlPermalink: 'https://granola.ai/d/doc-1',
  workspaceRef: 'ws-acme',
  occurredAt: '2026-09-01T15:00:00.000Z',
  body: 'Alice: We ship Friday.',
  raw: { title: 'Standup' },
  acl: { rules: [], capturedAt: '2026-09-01T15:00:00.000Z', ttlSeconds: 3600 },
};

describe('connectorContentHash', () => {
  it('is a stable sha256 of the body', () => {
    expect(connectorContentHash(ARTIFACT)).toMatch(/^[0-9a-f]{64}$/);
    expect(connectorContentHash(ARTIFACT)).toBe(connectorContentHash({ ...ARTIFACT }));
  });

  it('falls back to the structured payload when there is no body', () => {
    const a = { ...ARTIFACT, body: undefined, raw: { title: 'X' } };
    const b = { ...ARTIFACT, body: undefined, raw: { title: 'Y' } };
    expect(connectorContentHash(a)).not.toBe(connectorContentHash(b));
  });
});

describe('buildConnectorSource', () => {
  it('full-retention: encrypts the body into raw_body, round-trips via the cipher', async () => {
    const { cipher, tenantId, engagementId } = await newCipher();
    const built = await buildConnectorSource(cipher, {
      tenantId,
      engagementId,
      artifact: ARTIFACT,
      retentionPolicy: 'full-retention',
      aclSnapshotId: 'acl-1',
    });

    expect(built.bodyRetained).toBe(true);
    expect(built.row.rawBody).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(built.row.rawBody!).toString('utf8')).not.toContain('Friday');
    expect(await cipher.decryptString('sources.raw_body', built.row.rawBody!)).toBe(ARTIFACT.body);
    expect(built.row).toMatchObject({
      connector: 'granola',
      externalId: 'doc-1',
      kind: 'transcript',
      urlPermalink: 'https://granola.ai/d/doc-1',
      workspaceRef: 'ws-acme',
      aclSnapshotId: 'acl-1',
    });
    expect(built.row.occurredAt).toEqual(new Date(ARTIFACT.occurredAt));
  });

  it('reference-only: stores no body, only metadata + the dedupe hash', async () => {
    const { cipher, tenantId, engagementId } = await newCipher();
    const built = await buildConnectorSource(cipher, {
      tenantId,
      engagementId,
      artifact: ARTIFACT,
      retentionPolicy: 'reference-only',
      aclSnapshotId: null,
    });
    expect(built.bodyRetained).toBe(false);
    expect(built.row.rawBody).toBeUndefined();
    expect(built.row.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(built.row.aclSnapshotId).toBeNull();
  });

  it('rejects an artifact that fails rawArtifactSchema', async () => {
    const { cipher, tenantId, engagementId } = await newCipher();
    await expect(
      buildConnectorSource(cipher, {
        tenantId,
        engagementId,
        artifact: { ...ARTIFACT, occurredAt: 'not-a-date' },
        retentionPolicy: 'full-retention',
        aclSnapshotId: null,
      }),
    ).rejects.toThrow();
  });
});
