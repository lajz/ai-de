import { describe, expect, it } from 'vitest';

import { canonicalRecordSchema } from './canonical.js';
import {
  customIntegrationMappingSchema,
  type CustomIntegrationMapping,
} from './custom-integration-mapping.js';
import {
  buildCustomRawArtifact,
  CustomMappingValidationError,
  normalizeCustomArtifact,
  resolveDotPath,
} from './custom-integration-normalize.js';
import { rawArtifactSchema } from './raw-artifact.js';

const mapping: CustomIntegrationMapping = customIntegrationMappingSchema.parse({
  artifact: {
    externalIdPath: 'ticket.id',
    kind: 'issue',
    occurredAtPath: 'ticket.createdAt',
    urlPermalinkPath: 'ticket.url',
  },
  entities: [
    {
      key: 'ticket',
      type: 'work_item',
      externalIdPath: 'ticket.id',
      displayNamePath: 'ticket.title',
      bodyPath: 'ticket.description',
      attributes: { status: 'ticket.status' },
    },
    {
      key: 'reporter',
      type: 'person',
      externalIdPath: 'ticket.reporter.id',
      displayNamePath: 'ticket.reporter.name',
    },
  ],
  relationships: [{ from: 'reporter', predicate: 'relates_to', to: 'ticket' }],
});

const payload = {
  ticket: {
    id: 42,
    title: 'Printer on fire',
    description: 'smoke',
    status: 'open',
    createdAt: '2026-01-02T03:04:05Z',
    url: 'https://example.com/t/42',
    reporter: { id: 'u1', name: 'Ada' },
    tags: ['a', 'b'],
  },
};

describe('resolveDotPath', () => {
  it.each([
    ['ticket.title', 'Printer on fire'],
    ['ticket.tags[1]', 'b'],
    ['ticket.reporter.name', 'Ada'],
    ['ticket.tags[5]', undefined],
    ['ticket.missing.deeper', undefined],
    ['ticket.title.length', undefined],
    ['ticket.tags.length', undefined],
    ['ticket[0]', undefined],
    ['__proto__', undefined],
    ['ticket.constructor', undefined],
  ])('%s -> %j', (path, expected) => {
    expect(resolveDotPath(payload, path)).toEqual(expected);
  });
  it('never throws on non-object roots', () => {
    expect(resolveDotPath(null, 'a')).toBeUndefined();
    expect(resolveDotPath('str', 'a')).toBeUndefined();
  });
});

describe('normalizeCustomArtifact', () => {
  it('emits entities + relationships that validate as canonical records', () => {
    const { records, issues } = normalizeCustomArtifact(mapping, 'custom:x', payload);
    expect(issues).toEqual([]);
    expect(() => canonicalRecordSchema.array().parse(records)).not.toThrow();
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({
      type: 'work_item',
      externalRefs: [{ connector: 'custom:x', externalId: '42' }],
      attributes: { status: 'open' },
      body: 'smoke',
    });
    expect(records[2]).toMatchObject({
      kind: 'relationship',
      from: { externalId: 'u1' },
      to: { externalId: '42' },
    });
  });

  it('non-strict returns the partial result plus issues; dangling relationship dropped', () => {
    const p = { ticket: { ...payload.ticket, reporter: {} } };
    const { records, issues } = normalizeCustomArtifact(mapping, 'custom:x', p);
    expect(records.map((r) => r.kind)).toEqual(['entity']);
    expect(issues.map((i) => i.at)).toEqual([
      'entities[1].externalIdPath',
      'entities[1].displayNamePath',
      'relationships[0]',
    ]);
  });

  it('strict throws CustomMappingValidationError with the issues', () => {
    const p = { ticket: { ...payload.ticket, status: undefined } };
    try {
      normalizeCustomArtifact(mapping, 'custom:x', p, { strict: true });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CustomMappingValidationError);
      expect((e as CustomMappingValidationError).issues[0]?.at).toBe(
        'entities[0].attributes.status',
      );
    }
  });

  it('flags a non-string body', () => {
    const p = { ticket: { ...payload.ticket, description: { x: 1 } } };
    expect(normalizeCustomArtifact(mapping, 'c', p).issues[0]?.at).toBe('entities[0].bodyPath');
  });
});

describe('buildCustomRawArtifact', () => {
  it('builds a schema-valid artifact stashing the payload in raw', () => {
    const a = buildCustomRawArtifact(mapping.artifact, 'custom:x', payload);
    expect(() => rawArtifactSchema.parse(a)).not.toThrow();
    expect(a).toMatchObject({
      externalId: '42',
      kind: 'issue',
      occurredAt: '2026-01-02T03:04:05.000Z',
      urlPermalink: 'https://example.com/t/42',
      raw: payload,
    });
  });
  it('normalizes offset timestamps to UTC', () => {
    const p = { ticket: { ...payload.ticket, createdAt: '2026-01-02T05:04:05+02:00' } };
    expect(buildCustomRawArtifact(mapping.artifact, 'c', p).occurredAt).toBe(
      '2026-01-02T03:04:05.000Z',
    );
  });
  it.each([
    ['missing id', { ticket: { ...payload.ticket, id: undefined } }],
    ['bad timestamp', { ticket: { ...payload.ticket, createdAt: 'yesterday' } }],
    ['bad url', { ticket: { ...payload.ticket, url: 'nope' } }],
  ])('throws on %s', (_n, p) => {
    expect(() => buildCustomRawArtifact(mapping.artifact, 'c', p)).toThrow(
      CustomMappingValidationError,
    );
  });
});
