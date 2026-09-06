import { describe, expect, it } from 'vitest';

import {
  createEngagementCipher,
  DecryptContextMismatchError,
  EngagementCipher,
  FakeKeyProvider,
} from './index.js';

const ids = { tenantId: 't-1' as never, engagementId: 'e-1' as never };
const provider = new FakeKeyProvider();

async function newCipher(): Promise<EngagementCipher> {
  const { wrappedDek } = await provider.generateDek({
    ...ids,
    tenantCmkArn: 'arn:cmk',
  });
  return createEngagementCipher(provider, { ...ids, tenantCmkArn: 'arn:cmk', wrappedDek });
}

describe('EngagementCipher', () => {
  it('round-trips a string', async () => {
    const c = await newCipher();
    const ct = await c.encryptString('facts.body', 'the customer picked Postgres');
    expect(ct).toBeInstanceOf(Uint8Array);
    expect(await c.decryptString('facts.body', ct)).toBe('the customer picked Postgres');
  });

  it('round-trips JSON', async () => {
    const c = await newCipher();
    const value = { rules: [{ scope: 'slack_channel', resourceId: 'C1', principals: ['U1'] }] };
    const ct = await c.encryptJson('acl_snapshots.principal_rules', value);
    expect(await c.decryptJson('acl_snapshots.principal_rules', ct)).toEqual(value);
  });

  it('rejects a decrypt under the wrong column path', async () => {
    const c = await newCipher();
    const ct = await c.encryptString('facts.body', 'secret');
    await expect(c.decryptString('facts.summary', ct)).rejects.toBeInstanceOf(
      DecryptContextMismatchError,
    );
  });

  it('rejects a decrypt with a different engagement DEK', async () => {
    const a = await newCipher();
    const b = await newCipher();
    const ct = await a.encryptString('facts.body', 'secret');
    await expect(b.decryptString('facts.body', ct)).rejects.toThrow();
  });

  it('cannot decrypt another engagement even with the same DEK bytes', async () => {
    // Two engagements that somehow share DEK bytes: the encryption context
    // (engagementId) is bound into the AEAD, so the Encryption SDK itself rejects
    // the cross-engagement decrypt before our explicit context check is reached.
    const { wrappedDek } = await provider.generateDek({ ...ids, tenantCmkArn: 'arn:cmk' });
    const dek = await provider.unwrapDek({ ...ids, tenantCmkArn: 'arn:cmk' }, wrappedDek);
    const eA = new EngagementCipher('t-1' as never, 'e-1' as never, dek);
    const eB = new EngagementCipher('t-1' as never, 'e-2' as never, dek);
    const ct = await eA.encryptString('facts.body', 'secret');
    await expect(eB.decryptString('facts.body', ct)).rejects.toThrow();
  });
});
