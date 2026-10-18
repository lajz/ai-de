import {
  customIntegrationMappingSchema,
  CustomMappingValidationError,
  rawArtifactSchema,
  type RetentionPolicy,
} from '@fde/core';
import { describe, expect, it } from 'vitest';

import { CustomPayloadError, CustomWebhookConnector } from './custom-connector.js';

const mapping = customIntegrationMappingSchema.parse({
  artifact: { externalIdPath: 'id', kind: 'doc', occurredAtPath: 'at' },
  entities: [
    { key: 'd', type: 'document', externalIdPath: 'id', displayNamePath: 'title' },
    { key: 'p', type: 'person', externalIdPath: 'author.id', displayNamePath: 'author.name' },
  ],
  relationships: [{ from: 'p', predicate: 'relates_to', to: 'd' }],
});

function connector(policy: RetentionPolicy = 'full-retention') {
  return new CustomWebhookConnector({
    integrationId: 'abc',
    mapping,
    engagementRetentionPolicy: policy,
  });
}
const body = (v: unknown) => ({
  headers: {},
  rawBody: new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v)),
  connectorId: 'custom:abc',
});

const good = {
  id: 'd1',
  title: 'Spec',
  at: '2026-02-03T04:05:06Z',
  author: { id: 'u1', name: 'Bo' },
};

describe('CustomWebhookConnector', () => {
  it('contract: id, authKind, retention passthrough, no-op sync', async () => {
    const c = connector('reference-only');
    expect(c.id).toBe('custom:abc');
    expect(c.authKind).toBe('inbound-push');
    expect(c.retentionPolicy).toBe('reference-only');
    for await (const _ of c.backfill()) expect.unreachable();
    for await (const _ of c.incremental()) expect.unreachable();
  });

  it('handleWebhook builds one schema-valid artifact; normalize derives records', async () => {
    const c = connector();
    const arts = await c.handleWebhook(body(good));
    expect(arts).toHaveLength(1);
    const art = rawArtifactSchema.parse(arts[0]);
    expect(art.connector).toBe('custom:abc');
    const records = c.normalize(art);
    expect(records.map((r) => r.kind)).toEqual(['entity', 'entity', 'relationship']);
  });

  it('resolveAcl returns empty rules', async () => {
    const acl = await connector().resolveAcl();
    expect(acl.rules).toEqual([]);
    expect(acl.ttlSeconds).toBeGreaterThan(0);
  });

  it.each(['not json', '[1,2]', '"str"', 'null', '42'])('rejects payload %s', async (raw) => {
    await expect(connector().handleWebhook(body(raw))).rejects.toBeInstanceOf(CustomPayloadError);
  });

  it('rejects invalid UTF-8', async () => {
    await expect(
      connector().handleWebhook({
        headers: {},
        rawBody: new Uint8Array([0xff, 0xfe]),
        connectorId: 'x',
      }),
    ).rejects.toBeInstanceOf(CustomPayloadError);
  });

  it('rejects a payload missing artifact fields with a mapping error', async () => {
    await expect(connector().handleWebhook(body({ title: 'x' }))).rejects.toBeInstanceOf(
      CustomMappingValidationError,
    );
  });

  it('normalize is strict: unresolved entity fields throw', async () => {
    const c = connector();
    const [art] = await c.handleWebhook(body({ ...good, author: {} }));
    expect(() => c.normalize(art!)).toThrow(CustomMappingValidationError);
  });
});
