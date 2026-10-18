import { describe, expect, it } from 'vitest';

import { customIntegrationMappingSchema, dotPathSchema } from './custom-integration-mapping.js';

const valid = {
  artifact: { externalIdPath: 'id', kind: 'issue', occurredAtPath: 'at' },
  entities: [
    { key: 'a', type: 'work_item', externalIdPath: 'id', displayNamePath: 'title' },
    { key: 'b', type: 'person', externalIdPath: 'who.id', displayNamePath: 'who.name' },
  ],
  relationships: [{ from: 'b', predicate: 'relates_to', to: 'a' }],
};

describe('dotPathSchema', () => {
  it.each(['a', 'a.b', 'a[0]', 'a.b[0].c', 'a[0][1]', '_x.y-z', '$a'])('accepts %s', (p) => {
    expect(dotPathSchema.safeParse(p).success).toBe(true);
  });
  it.each(['', '.a', 'a.', 'a..b', '[0]', 'a[]', 'a[x]', 'a b', 'a.*', '$.a[?(@.x)]', '1a'])(
    'rejects %s',
    (p) => {
      expect(dotPathSchema.safeParse(p).success).toBe(false);
    },
  );
});

describe('customIntegrationMappingSchema', () => {
  it('accepts a valid mapping and defaults attributes/relationships', () => {
    const r = customIntegrationMappingSchema.parse({ ...valid, relationships: undefined });
    expect(r.relationships).toEqual([]);
    expect(r.entities[0]?.attributes).toEqual({});
  });
  it('requires at least one entity', () => {
    expect(customIntegrationMappingSchema.safeParse({ ...valid, entities: [] }).success).toBe(
      false,
    );
  });
  it('rejects duplicate entity keys', () => {
    const e = valid.entities[0]!;
    const r = customIntegrationMappingSchema.safeParse({ ...valid, entities: [e, e] });
    expect(r.success).toBe(false);
  });
  it('rejects relationships referencing undeclared keys', () => {
    const r = customIntegrationMappingSchema.safeParse({
      ...valid,
      relationships: [{ from: 'a', predicate: 'relates_to', to: 'nope' }],
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('unknown entity key');
  });
  it('rejects unknown entity types / predicates / kinds', () => {
    expect(
      customIntegrationMappingSchema.safeParse({
        ...valid,
        artifact: { ...valid.artifact, kind: 'bogus' },
      }).success,
    ).toBe(false);
    expect(
      customIntegrationMappingSchema.safeParse({
        ...valid,
        relationships: [{ from: 'a', predicate: 'bogus', to: 'b' }],
      }).success,
    ).toBe(false);
  });
});
