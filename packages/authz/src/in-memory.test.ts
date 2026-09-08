import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { EngagementId, TenantId, UserId } from '@fde/core';
import { describe, expect, it } from 'vitest';

import { AuthzError } from './errors.js';
import { InMemoryAuthzClient } from './in-memory.js';
import { AUTHZ_SCHEMA } from './schema.js';

const user = (n: string) => n as UserId;
const eng = (n: string) => n as EngagementId;
const ten = (n: string) => n as TenantId;

/** Meaningful lines only — drop `//` comments and blank lines, trim indentation. */
const defs = (s: string) =>
  s
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, '').trim())
    .filter(Boolean)
    .join('\n');

describe('AUTHZ_SCHEMA', () => {
  it('matches the committed schema.zed byte-for-byte (modulo comments)', () => {
    const zed = readFileSync(join(import.meta.dirname, '../schema.zed'), 'utf8');
    expect(defs(AUTHZ_SCHEMA)).toBe(defs(zed));
  });
});

describe('InMemoryAuthzClient permission resolution', () => {
  it('viewer → view only', async () => {
    const az = new InMemoryAuthzClient();
    await az.grantEngagementRole(user('u'), eng('e'), 'viewer');
    expect(await az.canViewEngagement(user('u'), eng('e'))).toBe(true);
    expect(await az.canContributeToEngagement(user('u'), eng('e'))).toBe(false);
    expect(await az.canAdministerEngagement(user('u'), eng('e'))).toBe(false);
  });

  it('member → view + contribute', async () => {
    const az = new InMemoryAuthzClient();
    await az.grantEngagementRole(user('u'), eng('e'), 'member');
    expect(await az.canViewEngagement(user('u'), eng('e'))).toBe(true);
    expect(await az.canContributeToEngagement(user('u'), eng('e'))).toBe(true);
    expect(await az.canAdministerEngagement(user('u'), eng('e'))).toBe(false);
  });

  it('admin → view + contribute + administer', async () => {
    const az = new InMemoryAuthzClient();
    await az.grantEngagementRole(user('u'), eng('e'), 'admin');
    expect(await az.canViewEngagement(user('u'), eng('e'))).toBe(true);
    expect(await az.canContributeToEngagement(user('u'), eng('e'))).toBe(true);
    expect(await az.canAdministerEngagement(user('u'), eng('e'))).toBe(true);
  });

  it('tenant admin inherits engagement view via parent_tenant->administer (but not contribute/administer)', async () => {
    const az = new InMemoryAuthzClient();
    await az.grantTenantRole(user('boss'), ten('t'), 'admin');
    await az.linkEngagementToTenant(eng('e'), ten('t'));
    expect(await az.canViewEngagement(user('boss'), eng('e'))).toBe(true);
    expect(await az.canContributeToEngagement(user('boss'), eng('e'))).toBe(false);
    expect(await az.canAdministerEngagement(user('boss'), eng('e'))).toBe(false);
    expect(await az.canAdministerTenant(user('boss'), ten('t'))).toBe(true);
  });

  it('tenant member does not inherit engagement view', async () => {
    const az = new InMemoryAuthzClient();
    await az.grantTenantRole(user('u'), ten('t'), 'member');
    await az.linkEngagementToTenant(eng('e'), ten('t'));
    expect(await az.canViewEngagement(user('u'), eng('e'))).toBe(false);
  });

  it('isTenantMember is true for a tenant member and a tenant admin, false otherwise', async () => {
    const az = new InMemoryAuthzClient();
    await az.grantTenantRole(user('m'), ten('t'), 'member');
    await az.grantTenantRole(user('a'), ten('t'), 'admin');
    expect(await az.isTenantMember(user('m'), ten('t'))).toBe(true);
    expect(await az.isTenantMember(user('a'), ten('t'))).toBe(true);
    expect(await az.isTenantMember(user('stranger'), ten('t'))).toBe(false);
  });

  it('an unrelated user has nothing', async () => {
    const az = new InMemoryAuthzClient();
    await az.grantEngagementRole(user('u'), eng('e'), 'admin');
    expect(await az.canViewEngagement(user('stranger'), eng('e'))).toBe(false);
    expect(await az.canViewEngagement(user('u'), eng('other'))).toBe(false);
  });

  it('revokeEngagementRoles drops every role on that engagement, leaving others intact', async () => {
    const az = new InMemoryAuthzClient();
    await az.grantEngagementRole(user('u'), eng('e1'), 'admin');
    await az.grantEngagementRole(user('u'), eng('e2'), 'viewer');
    await az.revokeEngagementRoles(user('u'), eng('e1'));
    expect(await az.canViewEngagement(user('u'), eng('e1'))).toBe(false);
    expect(await az.canViewEngagement(user('u'), eng('e2'))).toBe(true);
  });
});

describe('InMemoryAuthzClient lookupResources / listViewableEngagements', () => {
  it('returns exactly the viewable engagements, sorted, direct role or tenant-admin', async () => {
    const az = new InMemoryAuthzClient();
    await az.grantEngagementRole(user('u'), eng('e-viewer'), 'viewer');
    await az.grantEngagementRole(user('u'), eng('e-member'), 'member');
    await az.grantTenantRole(user('u'), ten('t'), 'admin');
    await az.linkEngagementToTenant(eng('e-via-tenant'), ten('t'));
    await az.grantEngagementRole(user('other'), eng('e-other'), 'admin');

    expect(await az.listViewableEngagements(user('u'))).toEqual([
      'e-member',
      'e-via-tenant',
      'e-viewer',
    ]);
    expect(await az.listViewableEngagements(user('nobody'))).toEqual([]);
  });
});

describe('InMemoryAuthzClient relationship writes', () => {
  it('CREATE twice throws, TOUCH is idempotent', async () => {
    const az = new InMemoryAuthzClient();
    const rel = {
      resource: { type: 'engagement', id: 'e' },
      relation: 'viewer',
      subject: { type: 'user', id: 'u' },
    } as const;
    await az.writeRelationships([{ operation: 'CREATE', ...rel }]);
    await expect(az.writeRelationships([{ operation: 'CREATE', ...rel }])).rejects.toBeInstanceOf(
      AuthzError,
    );
    await az.writeRelationships([{ operation: 'TOUCH', ...rel }]);
    expect(await az.canViewEngagement(user('u'), eng('e'))).toBe(true);
  });

  it('deleteRelationships honours the filter', async () => {
    const az = new InMemoryAuthzClient();
    await az.grantEngagementRole(user('a'), eng('e'), 'viewer');
    await az.grantEngagementRole(user('b'), eng('e'), 'viewer');
    await az.deleteRelationships({
      resourceType: 'engagement',
      resourceId: 'e',
      relation: 'viewer',
      subject: { type: 'user', id: 'a' },
    });
    expect(await az.canViewEngagement(user('a'), eng('e'))).toBe(false);
    expect(await az.canViewEngagement(user('b'), eng('e'))).toBe(true);
  });

  it('writeSchema stores the schema', async () => {
    const az = new InMemoryAuthzClient();
    await az.writeSchema(AUTHZ_SCHEMA);
    expect(az.currentSchema()).toBe(AUTHZ_SCHEMA);
  });
});
