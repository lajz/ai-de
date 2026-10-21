import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { EngagementId, TenantId, UserId } from '@fde/core';
import { InMemoryAuthzClient } from '@fde/authz';
import type { ConnectorRegistry } from '@fde/connectors';
import type { EngagementCipher } from '@fde/crypto';
import { ConnectorScopeConflictError } from '@fde/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../config/env.js';
import { runWithRequestContext } from '@fde/request-context';
import type { TemporalConnectorPoll, TemporalConnectorSync } from '../temporal/temporal.module.js';
import { AdminService, parsePutConnectorBody } from './admin.service.js';

const tenantId = randomUUID() as TenantId;
const userId = randomUUID() as UserId;
const engagementId = randomUUID() as EngagementId;

/** drizzle-shaped fake: each `.select()` consumes the next queued rowset; upserts are recorded. */
function fakeTx(selectResults: unknown[][], upsertError?: unknown) {
  const inserts: { values: Record<string, unknown>; set: Record<string, unknown> }[] = [];
  let i = 0;
  const chain = (rows: unknown[]): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'orderBy', 'limit', 'innerJoin', 'leftJoin', 'groupBy']) {
      c[m] = () => c;
    }
    c.then = (ok: (v: unknown[]) => unknown, err?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(ok, err);
    return c;
  };
  const tx = {
    select: () => chain(selectResults[i++] ?? []),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: (cfg: { set: Record<string, unknown> }) => {
          inserts.push({ values, set: cfg.set });
          return upsertError ? Promise.reject(upsertError) : Promise.resolve();
        },
      }),
    }),
  };
  return { tx, inserts };
}

const cipher = {
  encryptString: vi.fn(async (_p: string, v: string) => new TextEncoder().encode(`ENC(${v})`)),
} as unknown as EngagementCipher;

const config = (enforce: boolean) =>
  ({
    get: (k: string) => (k === 'AUTHZ_ENFORCE' ? String(enforce) : undefined),
  }) as unknown as ConfigService<Env, true>;

const registry = {
  ids: ['granola'],
  has: (id: string) => id === 'granola',
  build: (id: string) => ({ id, authKind: 'bearer', retentionPolicy: 'full-retention' }),
} as unknown as ConnectorRegistry;

const temporal = (configured: boolean) =>
  ({
    configured,
    start: vi.fn(async () => ({ workflowId: 'wf-123' })),
  }) as unknown as TemporalConnectorSync & { start: ReturnType<typeof vi.fn> };

const poll = () =>
  ({
    configured: true,
    upsert: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  }) as unknown as TemporalConnectorPoll & {
    upsert: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };

function run<T>(tx: unknown, fn: () => Promise<T>): Promise<T> {
  return runWithRequestContext(
    { tenantId, userId, tx: tx as never, engagement: { id: engagementId, cipher } },
    fn,
  );
}

const engRow = [{ retentionPolicy: 'full-retention' }];

beforeEach(() => vi.clearAllMocks());

describe('AdminService.listConnectors', () => {
  it('merges registry + config + sync-state into one row per connector', async () => {
    const svc = new AdminService(
      registry,
      new InMemoryAuthzClient(),
      temporal(true),
      poll(),
      config(false),
    );
    const { tx } = fakeTx([
      engRow,
      [
        {
          connector: 'granola',
          enabled: true,
          retentionOverride: null,
          credentialRef: new Uint8Array([1]),
          updatedAt: new Date(),
        },
      ],
      [
        {
          connector: 'granola',
          status: 'idle',
          cursor: 'c1',
          lastRunAt: new Date('2026-03-01T00:00:00Z'),
          updatedAt: new Date(),
        },
      ],
    ]);
    const [row] = await run(tx, () => svc.listConnectors());
    expect(row).toEqual({
      connector: 'granola',
      authKind: 'bearer',
      enabled: true,
      effectiveRetention: 'full-retention',
      hasCredential: true,
      externalScopeRef: null,
      pollIntervalSeconds: null,
      sync: { status: 'idle', lastRunAt: '2026-03-01T00:00:00.000Z', cursorPresent: true },
    });
  });

  it('reports an unconfigured connector with no credential and a null sync', async () => {
    const svc = new AdminService(
      registry,
      new InMemoryAuthzClient(),
      temporal(true),
      poll(),
      config(false),
    );
    const { tx } = fakeTx([engRow, [], []]);
    const [row] = await run(tx, () => svc.listConnectors());
    expect(row).toMatchObject({
      enabled: false,
      hasCredential: false,
      sync: { status: null, lastRunAt: null, cursorPresent: false },
    });
  });

  it('403s under enforce when the caller has no role', async () => {
    const svc = new AdminService(
      registry,
      new InMemoryAuthzClient(),
      temporal(true),
      poll(),
      config(true),
    );
    await expect(run(fakeTx([]).tx, () => svc.listConnectors())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});

describe('AdminService.putConnector', () => {
  async function adminSvc() {
    const authz = new InMemoryAuthzClient();
    await authz.grantTenantRole(userId, tenantId, 'admin');
    return new AdminService(registry, authz, temporal(true), poll(), config(true));
  }

  it('encrypts the credential, stores ciphertext, and never returns the secret', async () => {
    const svc = await adminSvc();
    const { tx, inserts } = fakeTx([
      // buildViews re-read after the upsert
      engRow,
      [
        {
          connector: 'granola',
          enabled: true,
          retentionOverride: null,
          credentialRef: new Uint8Array([9]),
          updatedAt: new Date(),
        },
      ],
      [],
    ]);
    const res = await run(tx, () =>
      svc.putConnector('granola', {
        enabled: true,
        credential: 'grn_secret_token',
        retentionOverrideProvided: false,
        pollIntervalSecondsProvided: false,
      }),
    );

    expect(cipher.encryptString).toHaveBeenCalledWith(
      'connector_config.credential_ref',
      'grn_secret_token',
    );
    const stored = inserts[0]!.values.credentialRef as Uint8Array;
    expect(new TextDecoder().decode(stored)).toBe('ENC(grn_secret_token)');
    expect(JSON.stringify(res)).not.toContain('grn_secret_token');
    expect(res).toMatchObject({ connector: 'granola', hasCredential: true });
  });

  it('omits credentialRef from the upsert when no credential is supplied', async () => {
    const svc = await adminSvc();
    const { tx, inserts } = fakeTx([engRow, [], []]);
    await run(tx, () =>
      svc.putConnector('granola', {
        enabled: false,
        retentionOverrideProvided: false,
        pollIntervalSecondsProvided: false,
      }),
    );
    expect(inserts[0]!.set).not.toHaveProperty('credentialRef');
    expect(cipher.encryptString).not.toHaveBeenCalled();
  });

  it('400s on an unknown connector id', async () => {
    const svc = await adminSvc();
    await expect(
      run(fakeTx([]).tx, () =>
        svc.putConnector('notaconnector', {
          retentionOverrideProvided: false,
          pollIntervalSecondsProvided: false,
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('403s a caller who is neither engagement nor tenant admin', async () => {
    const authz = new InMemoryAuthzClient();
    await authz.grantEngagementRole(userId, engagementId, 'member');
    const svc = new AdminService(registry, authz, temporal(true), poll(), config(true));
    await expect(
      run(fakeTx([]).tx, () =>
        svc.putConnector('granola', {
          retentionOverrideProvided: false,
          pollIntervalSecondsProvided: false,
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('writes externalScopeRef into the upsert when provided', async () => {
    const svc = await adminSvc();
    const { tx, inserts } = fakeTx([engRow, [], []]);
    await run(tx, () =>
      svc.putConnector('granola', {
        retentionOverrideProvided: false,
        pollIntervalSecondsProvided: false,
        externalScopeRefProvided: true,
        externalScopeRef: 'linear-org-1',
      }),
    );
    expect(inserts[0]!.values.externalScopeRef).toBe('linear-org-1');
    expect(inserts[0]!.set.externalScopeRef).toBe('linear-org-1');
  });

  it('omits externalScopeRef from the upsert when the body never mentioned it', async () => {
    const svc = await adminSvc();
    const { tx, inserts } = fakeTx([engRow, [], []]);
    await run(tx, () =>
      svc.putConnector('granola', {
        enabled: true,
        retentionOverrideProvided: false,
        pollIntervalSecondsProvided: false,
      }),
    );
    expect(inserts[0]!.set).not.toHaveProperty('externalScopeRef');
  });

  it('409s when the scope ref is already claimed by another engagement', async () => {
    const svc = await adminSvc();
    const conflict = new ConnectorScopeConflictError('granola', 'linear-org-1');
    const { tx } = fakeTx([], conflict);
    await expect(
      run(tx, () =>
        svc.putConnector('granola', {
          retentionOverrideProvided: false,
          pollIntervalSecondsProvided: false,
          externalScopeRefProvided: true,
          externalScopeRef: 'linear-org-1',
        }),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('AdminService.putConnector poll reconciliation', () => {
  const cfgRow = (over: Record<string, unknown>) => ({
    connector: 'granola',
    enabled: true,
    retentionOverride: null,
    pollIntervalSeconds: 900,
    credentialRef: new Uint8Array([1]),
    updatedAt: new Date(),
    ...over,
  });

  async function setup(row: Record<string, unknown>) {
    const authz = new InMemoryAuthzClient();
    await authz.grantTenantRole(userId, tenantId, 'admin');
    const p = poll();
    const svc = new AdminService(registry, authz, temporal(true), p, config(true));
    const { tx } = fakeTx([engRow, [cfgRow(row)], []]);
    return { svc, p, tx };
  }
  const input = (over: Record<string, unknown>) => ({
    retentionOverrideProvided: false,
    pollIntervalSecondsProvided: false,
    ...over,
  });

  it('upserts the schedule when polling is set on an enabled, credentialed connector', async () => {
    const { svc, p, tx } = await setup({});
    const res = await run(tx, () =>
      svc.putConnector(
        'granola',
        input({ pollIntervalSecondsProvided: true, pollIntervalSeconds: 900 }),
      ),
    );
    expect(res.pollIntervalSeconds).toBe(900);
    expect(p.upsert).toHaveBeenCalledWith({
      tenantId,
      engagementId,
      connectorId: 'granola',
      intervalSeconds: 900,
    });
    expect(p.remove).not.toHaveBeenCalled();
  });

  it('removes the schedule when the connector is disabled while an interval is still set', async () => {
    const { svc, p, tx } = await setup({ enabled: false });
    await run(tx, () => svc.putConnector('granola', input({ enabled: false })));
    expect(p.remove).toHaveBeenCalledWith({ engagementId, connectorId: 'granola' });
    expect(p.upsert).not.toHaveBeenCalled();
  });

  it('removes the schedule when the credential is cleared', async () => {
    const { svc, p, tx } = await setup({ credentialRef: null });
    await run(tx, () => svc.putConnector('granola', input({})));
    expect(p.remove).toHaveBeenCalledWith({ engagementId, connectorId: 'granola' });
    expect(p.upsert).not.toHaveBeenCalled();
  });

  it('removes the schedule when polling is cleared (null) while still enabled', async () => {
    const { svc, p, tx } = await setup({ pollIntervalSeconds: null });
    await run(tx, () =>
      svc.putConnector(
        'granola',
        input({ pollIntervalSecondsProvided: true, pollIntervalSeconds: null }),
      ),
    );
    expect(p.remove).toHaveBeenCalledWith({ engagementId, connectorId: 'granola' });
    expect(p.upsert).not.toHaveBeenCalled();
  });

  it('persists pollIntervalSeconds only when the body carried the key', async () => {
    const { svc, tx } = await setup({});
    const { tx: tx2, inserts } = fakeTx([engRow, [cfgRow({})], []]);
    await run(tx2, () =>
      svc.putConnector(
        'granola',
        input({ pollIntervalSecondsProvided: true, pollIntervalSeconds: 3600 }),
      ),
    );
    expect(inserts[0]!.set.pollIntervalSeconds).toBe(3600);
    const { tx: tx3, inserts: ins3 } = fakeTx([engRow, [cfgRow({})], []]);
    await run(tx3, () => svc.putConnector('granola', input({ enabled: true })));
    expect(ins3[0]!.set).not.toHaveProperty('pollIntervalSeconds');
    void tx;
  });
});

describe('parsePutConnectorBody pollIntervalSeconds', () => {
  it.each([300, 86400, 3600])('accepts %s', (n) => {
    expect(parsePutConnectorBody({ pollIntervalSeconds: n })).toMatchObject({
      pollIntervalSecondsProvided: true,
      pollIntervalSeconds: n,
    });
  });
  it('accepts null (polling off)', () => {
    expect(parsePutConnectorBody({ pollIntervalSeconds: null })).toMatchObject({
      pollIntervalSecondsProvided: true,
      pollIntervalSeconds: null,
    });
  });
  it('marks the key not provided when omitted', () => {
    expect(parsePutConnectorBody({}).pollIntervalSecondsProvided).toBe(false);
  });
  it.each([299, 60, 86401, 100000, 600.5, '900', NaN, true])('400s on %s', (v) => {
    expect(() => parsePutConnectorBody({ pollIntervalSeconds: v })).toThrow(BadRequestException);
  });
});

describe('AdminService.startSync', () => {
  async function adminAuthz() {
    const authz = new InMemoryAuthzClient();
    await authz.grantTenantRole(userId, tenantId, 'admin');
    return authz;
  }

  it('starts the workflow when the connector is enabled and has a credential', async () => {
    const t = temporal(true);
    const svc = new AdminService(registry, await adminAuthz(), t, poll(), config(true));
    const { tx } = fakeTx([
      [
        {
          connector: 'granola',
          enabled: true,
          retentionOverride: null,
          credentialRef: new Uint8Array([1]),
          updatedAt: new Date(),
        },
      ],
    ]);
    const res = await run(tx, () => svc.startSync('granola', 'backfill'));
    expect(res).toEqual({ workflowId: 'wf-123' });
    expect(t.start).toHaveBeenCalledWith({
      tenantId,
      engagementId,
      connectorId: 'granola',
      mode: 'backfill',
    });
  });

  it('409s when the connector is not enabled', async () => {
    const svc = new AdminService(
      registry,
      await adminAuthz(),
      temporal(true),
      poll(),
      config(true),
    );
    const { tx } = fakeTx([
      [
        {
          connector: 'granola',
          enabled: false,
          retentionOverride: null,
          credentialRef: new Uint8Array([1]),
          updatedAt: new Date(),
        },
      ],
    ]);
    await expect(run(tx, () => svc.startSync('granola', 'incremental'))).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('409s when the connector has no stored credential', async () => {
    const svc = new AdminService(
      registry,
      await adminAuthz(),
      temporal(true),
      poll(),
      config(true),
    );
    const { tx } = fakeTx([
      [
        {
          connector: 'granola',
          enabled: true,
          retentionOverride: null,
          credentialRef: null,
          updatedAt: new Date(),
        },
      ],
    ]);
    await expect(run(tx, () => svc.startSync('granola', 'backfill'))).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('surfaces the gateway 503 when Temporal is unconfigured', async () => {
    const off = {
      configured: false,
      start: vi.fn(async () => {
        const { ServiceUnavailableException } = await import('@nestjs/common');
        throw new ServiceUnavailableException('Temporal is not configured');
      }),
    } as unknown as TemporalConnectorSync;
    const svc = new AdminService(registry, await adminAuthz(), off, poll(), config(true));
    const { tx } = fakeTx([
      [
        {
          connector: 'granola',
          enabled: true,
          retentionOverride: null,
          credentialRef: new Uint8Array([1]),
          updatedAt: new Date(),
        },
      ],
    ]);
    await expect(run(tx, () => svc.startSync('granola', 'backfill'))).rejects.toThrow(
      /not configured/,
    );
  });
});
