import { describe, expect, it } from 'vitest';

import { rawArtifactSchema } from './index.js';

const valid = {
  connector: 'granola',
  externalId: 'note_123',
  kind: 'transcript',
  occurredAt: '2026-09-01T10:00:00.000Z',
  acl: { rules: [], capturedAt: '2026-09-01T10:00:00.000Z', ttlSeconds: 300 },
};

describe('rawArtifactSchema', () => {
  it('accepts a minimal valid artifact', () => {
    const parsed = rawArtifactSchema.parse(valid);
    expect(parsed.connector).toBe('granola');
    expect(parsed.body).toBeUndefined();
  });

  it('requires an ACL snapshot', () => {
    const { acl: _acl, ...noAcl } = valid;
    expect(rawArtifactSchema.safeParse(noAcl).success).toBe(false);
  });

  it('rejects a non-ISO occurredAt', () => {
    expect(rawArtifactSchema.safeParse({ ...valid, occurredAt: 'yesterday' }).success).toBe(false);
  });

  it('rejects an unknown source kind', () => {
    expect(rawArtifactSchema.safeParse({ ...valid, kind: 'email' }).success).toBe(false);
  });
});
