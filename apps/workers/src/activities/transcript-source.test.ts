import { randomUUID } from 'node:crypto';

import type { EngagementId, TenantId } from '@fde/core';
import { createEngagementCipher, FakeKeyProvider, type EngagementCipher } from '@fde/crypto';
import { describe, expect, it } from 'vitest';

import { DEFAULT_FAKE_TRANSCRIPT } from '../capture/index.js';
import { buildTranscriptSource, renderTranscriptText } from './transcript-source.js';

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

const BASE = {
  botId: 'fake-bot-1',
  meetingUrl: 'https://example.com/meet/xyz',
  occurredAt: '2026-09-07T15:00:00.000Z',
  segments: DEFAULT_FAKE_TRANSCRIPT,
};

const EXPECTED_TEXT =
  "Alice Rivera: Welcome everyone, let's get started.\nBob Chen: Thanks Alice. We decided to ship Friday.";

describe('renderTranscriptText', () => {
  it('joins words into one speaker-tagged line per segment', () => {
    expect(renderTranscriptText(DEFAULT_FAKE_TRANSCRIPT)).toBe(EXPECTED_TEXT);
  });

  it('omits the speaker prefix when Recall did not diarize one', () => {
    expect(
      renderTranscriptText([{ speaker: null, words: [{ text: 'hello', start: 0, end: 1 }] }]),
    ).toBe('hello');
  });
});

describe('buildTranscriptSource', () => {
  it('full-retention: encrypts the transcript into raw_body, round-trips via the cipher', async () => {
    const { cipher, tenantId, engagementId } = await newCipher();
    const built = await buildTranscriptSource(cipher, {
      ...BASE,
      tenantId,
      engagementId,
      retentionPolicy: 'full-retention',
    });

    expect(built.bodyRetained).toBe(true);
    expect(built.row.rawBody).toBeInstanceOf(Uint8Array);
    // stored bytes are ciphertext, not the transcript text
    const bytes = Buffer.from(built.row.rawBody!).toString('utf8');
    expect(bytes).not.toContain('Friday');
    expect(bytes).not.toContain('Alice');
    // and they decrypt back to the plaintext through the same column path
    expect(await cipher.decryptString('sources.raw_body', built.row.rawBody!)).toBe(EXPECTED_TEXT);

    expect(built.artifact.kind).toBe('transcript');
    expect(built.artifact.connector).toBe('recall');
    expect(built.artifact.body).toBe(EXPECTED_TEXT);
    expect(built.row.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(built.row.occurredAt).toEqual(new Date(BASE.occurredAt));
  });

  it('derived-ephemeral-raw: still encrypts raw_body (purge is extraction’s job)', async () => {
    const { cipher, tenantId, engagementId } = await newCipher();
    const built = await buildTranscriptSource(cipher, {
      ...BASE,
      tenantId,
      engagementId,
      retentionPolicy: 'derived-ephemeral-raw',
    });
    expect(built.bodyRetained).toBe(true);
    expect(built.row.rawBody).toBeInstanceOf(Uint8Array);
  });

  it('reference-only: stores no body, only the permalink + metadata', async () => {
    const { cipher, tenantId, engagementId } = await newCipher();
    const built = await buildTranscriptSource(cipher, {
      ...BASE,
      tenantId,
      engagementId,
      retentionPolicy: 'reference-only',
    });
    expect(built.bodyRetained).toBe(false);
    expect(built.row.rawBody).toBeUndefined();
    expect(built.artifact.body).toBeUndefined();
    expect(built.row.urlPermalink).toBe(BASE.meetingUrl);
    // metadata (and the dedupe hash) are still there
    expect(built.row.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('contentHash is deterministic for the same transcript', async () => {
    const a = await newCipher();
    const b = await newCipher();
    const one = await buildTranscriptSource(a.cipher, {
      ...BASE,
      tenantId: a.tenantId,
      engagementId: a.engagementId,
      retentionPolicy: 'full-retention',
    });
    const two = await buildTranscriptSource(b.cipher, {
      ...BASE,
      tenantId: b.tenantId,
      engagementId: b.engagementId,
      retentionPolicy: 'full-retention',
    });
    expect(one.row.contentHash).toBe(two.row.contentHash);
    // but the ciphertext differs (fresh IV per encryption)
    expect(Buffer.from(one.row.rawBody!).equals(Buffer.from(two.row.rawBody!))).toBe(false);
  });
});
