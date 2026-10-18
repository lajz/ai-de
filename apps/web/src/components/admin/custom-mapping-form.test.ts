import { describe, expect, it } from 'vitest';

import { draftFromMapping, emptyDraft, mappingFromDraft } from './custom-mapping-form';

describe('mapping draft conversion', () => {
  it('round-trips a mapping', () => {
    const m = {
      artifact: { externalIdPath: 'id', kind: 'doc' as const, occurredAtPath: 'at' },
      entities: [
        {
          key: 'a',
          type: 'document' as const,
          externalIdPath: 'id',
          displayNamePath: 'title',
          bodyPath: 'body',
          attributes: { status: 'st' },
        },
      ],
      relationships: [{ from: 'a', predicate: 'relates_to' as const, to: 'a' }],
    };
    expect(mappingFromDraft(draftFromMapping(m))).toEqual(m);
  });

  it('omits blank optional paths and blank attribute rows', () => {
    const d = emptyDraft();
    d.entities[0]!.attributes = [
      { name: '', path: '' },
      { name: 'x', path: '' },
      { name: 'ok', path: ' a.b ' },
    ];
    const m = mappingFromDraft(d);
    expect(m.artifact).not.toHaveProperty('urlPermalinkPath');
    expect(m.entities[0]).not.toHaveProperty('bodyPath');
    expect(m.entities[0]?.attributes).toEqual({ ok: 'a.b' });
  });
});
