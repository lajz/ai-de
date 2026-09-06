import type { EncryptedColumnSpec } from '@fde/core';
import { describe, expect, it } from 'vitest';

import { createEngagementCipher, decryptRow, encryptRow, FakeKeyProvider } from './index.js';

const ids = { tenantId: 't-1' as never, engagementId: 'e-1' as never };

const specs = [
  { prop: 'body', path: 'facts.body', codec: 'string' },
  { prop: 'attributes', path: 'entities.attributes', codec: 'json' },
] as const satisfies readonly EncryptedColumnSpec[];

async function cipher() {
  const p = new FakeKeyProvider();
  const { wrappedDek } = await p.generateDek({ ...ids, tenantCmkArn: 'arn:cmk' });
  return createEngagementCipher(p, { ...ids, tenantCmkArn: 'arn:cmk', wrappedDek });
}

describe('field codec', () => {
  it('round-trips mixed string + json columns and preserves other fields', async () => {
    const c = await cipher();
    const row = { id: 'f1', body: 'a decision', attributes: { title: 'VP Eng' }, summary: 'plain' };

    const enc = await encryptRow(c, specs, row);
    expect(enc.id).toBe('f1');
    expect(enc.summary).toBe('plain');
    expect(enc.body).toBeInstanceOf(Uint8Array);
    expect(enc.attributes).toBeInstanceOf(Uint8Array);

    const dec = await decryptRow<typeof row>(c, specs, enc);
    expect(dec).toEqual(row);
  });

  it('skips null / undefined values', async () => {
    const c = await cipher();
    const row = { id: 'f2', body: null, attributes: undefined, summary: 's' };
    const enc = await encryptRow(c, specs, row as Record<string, unknown>);
    expect(enc.body).toBeNull();
    expect(enc.attributes).toBeUndefined();
  });
});
