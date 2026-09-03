import { describe, expect, it } from 'vitest';

import {
  createEngagementCipher,
  FakeKeyProvider,
  getCipher,
  MissingCryptoContextError,
  runWithCrypto,
  tryGetCryptoContext,
} from './index.js';

const ids = { tenantId: 't-1' as never, engagementId: 'e-1' as never };

async function cipher() {
  const p = new FakeKeyProvider();
  const { wrappedDek } = await p.generateDek({ ...ids, tenantCmkArn: 'arn:cmk' });
  return createEngagementCipher(p, { ...ids, tenantCmkArn: 'arn:cmk', wrappedDek });
}

describe('crypto context', () => {
  it('throws outside runWithCrypto', () => {
    expect(() => getCipher()).toThrow(MissingCryptoContextError);
    expect(tryGetCryptoContext()).toBeUndefined();
  });

  it('exposes the cipher inside runWithCrypto', async () => {
    const c = await cipher();
    await runWithCrypto({ ...ids, cipher: c }, async () => {
      expect(getCipher()).toBe(c);
      const ct = await getCipher().encryptString('facts.body', 'x');
      expect(await getCipher().decryptString('facts.body', ct)).toBe('x');
    });
  });

  it('does not leak the context after the callback resolves', async () => {
    const c = await cipher();
    await runWithCrypto({ ...ids, cipher: c }, async () => undefined);
    expect(() => getCipher()).toThrow(MissingCryptoContextError);
  });
});
