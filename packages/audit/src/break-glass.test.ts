import { describe, expect, it } from 'vitest';

import { assertSecondPerson, computeExpiresAt } from './break-glass.js';
import { SelfApprovalError } from './errors.js';

describe('assertSecondPerson', () => {
  it('allows approval by someone other than the requester', () => {
    expect(() => assertSecondPerson('alice', 'bob')).not.toThrow();
  });

  it('rejects self-approval', () => {
    expect(() => assertSecondPerson('alice', 'alice')).toThrow(SelfApprovalError);
  });
});

describe('computeExpiresAt', () => {
  it('adds the TTL in minutes to the reference time', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    expect(computeExpiresAt(60, now).toISOString()).toBe('2026-01-01T01:00:00.000Z');
    expect(computeExpiresAt(1, now).toISOString()).toBe('2026-01-01T00:01:00.000Z');
  });

  it('defaults `now` to the current time', () => {
    const before = Date.now();
    const expires = computeExpiresAt(0);
    expect(expires.getTime()).toBeGreaterThanOrEqual(before);
  });
});
