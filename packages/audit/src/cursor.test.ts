import { describe, expect, it } from 'vitest';

import { decodeCursor, encodeCursor, resolveLimit } from './cursor.js';

describe('resolveLimit', () => {
  it('defaults to 100 when omitted', () => {
    expect(resolveLimit(undefined)).toBe(100);
  });

  it('passes through an in-range value', () => {
    expect(resolveLimit(25)).toBe(25);
  });

  it('clamps above 500 down to 500', () => {
    expect(resolveLimit(10_000)).toBe(500);
  });

  it('clamps non-positive values up to 1', () => {
    expect(resolveLimit(0)).toBe(1);
    expect(resolveLimit(-5)).toBe(1);
  });
});

describe('encodeCursor / decodeCursor', () => {
  it('round-trips createdAt + id', () => {
    const cursor = { createdAt: new Date('2026-01-01T00:00:00.000Z'), id: 'abc-123' };
    const decoded = decodeCursor(encodeCursor(cursor));
    expect(decoded.createdAt.toISOString()).toBe(cursor.createdAt.toISOString());
    expect(decoded.id).toBe(cursor.id);
  });

  it('rejects a malformed cursor', () => {
    expect(() => decodeCursor('not-base64-json')).toThrow(/malformed/);
    expect(() => decodeCursor(Buffer.from('{}').toString('base64url'))).toThrow(/malformed/);
  });
});
