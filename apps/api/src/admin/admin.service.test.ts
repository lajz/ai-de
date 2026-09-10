import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { EngagementId, TenantId, UserId } from '@fde/core';
import { InMemoryAuthzClient } from '@fde/authz';
import type { ConnectorRegistry } from '@fde/connectors';
import type { EngagementCipher } from '@fde/crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../config/env.js';
import { runWithRequestContext } from '../request-context/request-context.js';
import type { TemporalConnectorSync } from '../temporal/temporal.module.js';
import { AdminService } from './admin.service.js';

const tenantId = randomUUID() as TenantId;
const userId = randomUUID() as UserId;
const engagementId = randomUUID() as EngagementId;

/** drizzle-shaped fake: each `.select()` consumes the next queued rowset; upserts are recorded. */
function fakeTx(selectResults: unknown[][]) {
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
          return Promise.resolve();
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
      sync: { status: 'idle', lastRunAt: '2026-03-01T00:00:00.000Z', cursorPresent: true },
    });
  });

  it('reports an unconfigured connector with no credential and a null sync', async () => {
    const svc = new AdminService(
      registry,
      new InMemoryAuthzClient(),
      temporal(true),
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
    const svc = new AdminService(registry, new InMemoryAuthzClient(), temporal(true), config(true));
    await expect(run(fakeTx([]).tx, () => svc.listConnectors())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});

describe('AdminService.putConnector', () => {
  async function adminSvc() {
    const authz = new InMemoryAuthzClient();
    await authz.grantTenantRole(userId, tenantId, 'admin');
    return new AdminService(registry, authz, temporal(true), config(true));
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
      svc.putConnector('granola', { enabled: false, retentionOverrideProvided: false }),
    );
    expect(inserts[0]!.set).not.toHaveProperty('credentialRef');
    expect(cipher.encryptString).not.toHaveBeenCalled();
  });

  it('400s on an unknown connector id', async () => {
    const svc = await adminSvc();
    await expect(
      run(fakeTx([]).tx, () =>
        svc.putConnector('notaconnector', { retentionOverrideProvided: false }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('403s a caller who is neither engagement nor tenant admin', async () => {
    const authz = new InMemoryAuthzClient();
    await authz.grantEngagementRole(userId, engagementId, 'member');
    const svc = new AdminService(registry, authz, temporal(true), config(true));
    await expect(
      run(fakeTx([]).tx, () => svc.putConnector('granola', { retentionOverrideProvided: false })),
    ).rejects.toBeInstanceOf(ForbiddenException);
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
    const svc = new AdminService(registry, await adminAuthz(), t, config(true));
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
    const svc = new AdminService(registry, await adminAuthz(), temporal(true), config(true));
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
    const svc = new AdminService(registry, await adminAuthz(), temporal(true), config(true));
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
    const svc = new AdminService(registry, await adminAuthz(), off, config(true));
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
