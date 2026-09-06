import { describe, expect, it } from 'vitest';

import { canonicalRecordSchema } from './index.js';

describe('canonicalRecordSchema', () => {
  it('parses an entity record', () => {
    const rec = canonicalRecordSchema.parse({
      kind: 'entity',
      type: 'person',
      displayName: 'Jane Smith',
      externalRefs: [{ connector: 'slack', externalId: 'U123' }],
    });
    expect(rec.kind).toBe('entity');
  });

  it('parses a relationship record', () => {
    const rec = canonicalRecordSchema.parse({
      kind: 'relationship',
      from: { connector: 'slack', externalId: 'U1' },
      predicate: 'owns',
      to: { connector: 'linear', externalId: 'ISS-1' },
    });
    expect(rec.kind).toBe('relationship');
  });

  it('rejects an unknown predicate', () => {
    const bad = canonicalRecordSchema.safeParse({
      kind: 'relationship',
      from: { connector: 'a', externalId: 'b' },
      predicate: 'frobnicates',
      to: { connector: 'c', externalId: 'd' },
    });
    expect(bad.success).toBe(false);
  });

  it('requires at least one external ref on an entity', () => {
    const bad = canonicalRecordSchema.safeParse({
      kind: 'entity',
      type: 'person',
      displayName: 'No Refs',
      externalRefs: [],
    });
    expect(bad.success).toBe(false);
  });
});
