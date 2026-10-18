import { describe, expect, it } from 'vitest';

import { generateSecret, hashSecretHex, secretMatches } from './secret-hash.js';

describe('secret-hash', () => {
  it('generate → match round trip, with the requested prefix', () => {
    const s = generateSecret({ rawPrefix: 'tst_', prefixLen: 8 });
    expect(s.raw.startsWith('tst_')).toBe(true);
    expect(s.prefix).toBe(s.raw.slice(0, 8));
    expect(s.hashHex).toBe(hashSecretHex(s.raw));
    expect(secretMatches(s.raw, s.hashHex)).toBe(true);
  });

  it('mints distinct secrets', () => {
    const a = generateSecret({ rawPrefix: 'x_', prefixLen: 4 });
    const b = generateSecret({ rawPrefix: 'x_', prefixLen: 4 });
    expect(a.raw).not.toBe(b.raw);
    expect(a.hashHex).not.toBe(b.hashHex);
  });

  it('rejects a different secret', () => {
    const s = generateSecret({ rawPrefix: 'x_', prefixLen: 4 });
    expect(secretMatches(`${s.raw}x`, s.hashHex)).toBe(false);
    expect(secretMatches('', s.hashHex)).toBe(false);
  });

  it.each(['', 'zz', 'abc', 'not hex at all', 'ab'.repeat(5), 'ab'.repeat(64)])(
    'never throws on malformed stored hash %j',
    (stored) => {
      expect(secretMatches('anything', stored)).toBe(false);
    },
  );
});
