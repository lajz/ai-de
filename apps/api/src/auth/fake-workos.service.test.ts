import 'reflect-metadata';

import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { FakeWorkOsService } from './fake-workos.service.js';

const SECRET = 'test-secret';

describe('FakeWorkOsService.verifyEvent', () => {
  const svc = new FakeWorkOsService(SECRET);
  const body = JSON.stringify({ id: 'evt_1', event: 'dsync.user.deleted', data: { id: 'u_1' } });

  it('accepts a correctly signed payload', async () => {
    const sig = FakeWorkOsService.signWebhook(body, SECRET);
    const event = await svc.verifyEvent(body, sig);
    expect(event).toMatchObject({ event: 'dsync.user.deleted', data: { id: 'u_1' } });
  });

  it('rejects a missing signature header', async () => {
    await expect(svc.verifyEvent(body, undefined)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a signature made with the wrong secret', async () => {
    const sig = FakeWorkOsService.signWebhook(body, 'wrong-secret');
    await expect(svc.verifyEvent(body, sig)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a tampered body', async () => {
    const sig = FakeWorkOsService.signWebhook(body, SECRET);
    await expect(svc.verifyEvent(`${body} `, sig)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('FakeWorkOsService.authenticateWithCode', () => {
  it('resolves a registered code and rejects an unknown one', async () => {
    const svc = new FakeWorkOsService();
    svc.register('good', {
      user: { id: 'u_1', email: 'a@example.com' },
      organizationId: 'org_1',
    });
    await expect(svc.authenticateWithCode('good')).resolves.toMatchObject({
      organizationId: 'org_1',
    });
    await expect(svc.authenticateWithCode('bad')).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
