import { describe, expect, it } from 'vitest';

import { FakeKeyProvider } from './fake-key-provider.js';

const ids = { tenantId: 't-1' as never, engagementId: 'e-1' as never };

describe('FakeKeyProvider.rewrapDek', () => {
  it('re-wraps the same DEK bytes — a rewrap is not a fresh generateDek', async () => {
    const provider = new FakeKeyProvider();
    const { dek, wrappedDek } = await provider.generateDek({ ...ids, tenantCmkArn: 'fake:cmk' });

    const rewrapped = await provider.rewrapDek({ ...ids, tenantCmkArn: 'fake:cmk' }, wrappedDek, {
      ...ids,
      tenantCmkArn: 'fake:cmk',
      byokKeyArn: 'fake:byok',
    });

    const unwrapped = await provider.unwrapDek(
      { ...ids, tenantCmkArn: 'fake:cmk', byokKeyArn: 'fake:byok' },
      rewrapped,
    );
    expect(Buffer.from(unwrapped).equals(Buffer.from(dek))).toBe(true);
  });

  it('rejects a wrap that is not shaped like a fake-wrapped DEK', async () => {
    const provider = new FakeKeyProvider();
    await expect(
      provider.rewrapDek({ ...ids, tenantCmkArn: 'fake:cmk' }, new Uint8Array([1, 2, 3]), {
        ...ids,
        tenantCmkArn: 'fake:cmk',
        byokKeyArn: 'fake:byok',
      }),
    ).rejects.toThrow(/not a fake-wrapped DEK/);
  });
});
