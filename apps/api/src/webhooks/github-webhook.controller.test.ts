import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import type { Connector, ConnectorWebhookRequest, RawArtifact } from '@fde/core';
import type { ConnectorRegistry } from '@fde/connectors';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { GitHubWebhookController } from './github-webhook.controller.js';
import type { WebhookLandingService } from './webhook-landing.service.js';

const ARTIFACT: RawArtifact = {
  connector: 'github',
  externalId: 'pr-1',
  kind: 'issue',
  occurredAt: '2026-09-05T00:00:00.000Z',
  raw: {},
  acl: { rules: [], capturedAt: '2026-09-05T00:00:00.000Z', ttlSeconds: 3600 },
};

function payload(repoFullName?: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      action: 'opened',
      pull_request: { id: 'pr-1', number: 1 },
      ...(repoFullName ? { repository: { full_name: repoFullName } } : {}),
    }),
  );
}

function fakeConnector(handleWebhook: Connector['handleWebhook']): Connector {
  return {
    id: 'github',
    authKind: 'nango-oauth',
    retentionPolicy: 'full-retention',
    backfill: async function* () {},
    incremental: async function* () {},
    handleWebhook,
    resolveAcl: async () => ({
      rules: [],
      capturedAt: '2026-09-05T00:00:00.000Z',
      ttlSeconds: 3600,
    }),
    normalize: () => [],
  };
}

function registryOf(connector: Connector): ConnectorRegistry {
  return {
    has: () => true,
    ids: ['github'],
    build: () => connector,
  } as unknown as ConnectorRegistry;
}

function req(rawBody: Buffer | undefined): { req: Request; rawBody: Buffer | undefined } {
  return {
    req: {
      headers: { 'x-hub-signature-256': 'sha256=sig', 'x-github-event': 'pull_request' },
      rawBody,
    } as unknown as Request,
    rawBody,
  };
}

describe('GitHubWebhookController', () => {
  it('400s when the raw body was not captured', async () => {
    const connector = fakeConnector(async () => []);
    const landing = { landWebhookArtifacts: vi.fn() } as unknown as WebhookLandingService;
    const controller = new GitHubWebhookController(registryOf(connector), landing);
    const { req: r } = req(undefined);
    await expect(controller.receive(r as never)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('401s and lands nothing when handleWebhook rejects the signature', async () => {
    const connector = fakeConnector(async () => {
      throw new Error('GitHubConnector.handleWebhook: bad x-hub-signature-256');
    });
    const landing = { landWebhookArtifacts: vi.fn() } as unknown as WebhookLandingService;
    const controller = new GitHubWebhookController(registryOf(connector), landing);
    const { req: r } = req(payload('acme/orion'));
    await expect(controller.receive(r as never)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(landing.landWebhookArtifacts).not.toHaveBeenCalled();
  });

  it('ignores quietly when handleWebhook yields no artifacts (e.g. an unrecognized action)', async () => {
    const connector = fakeConnector(async () => []);
    const landing = { landWebhookArtifacts: vi.fn() } as unknown as WebhookLandingService;
    const controller = new GitHubWebhookController(registryOf(connector), landing);
    const { req: r } = req(payload('acme/orion'));
    await expect(controller.receive(r as never)).resolves.toEqual({ status: 'ignored' });
    expect(landing.landWebhookArtifacts).not.toHaveBeenCalled();
  });

  it('ignores quietly when the verified payload carries no repository.full_name', async () => {
    const connector = fakeConnector(async () => [ARTIFACT]);
    const landing = { landWebhookArtifacts: vi.fn() } as unknown as WebhookLandingService;
    const controller = new GitHubWebhookController(registryOf(connector), landing);
    const { req: r } = req(payload(undefined));
    await expect(controller.receive(r as never)).resolves.toEqual({ status: 'ignored' });
    expect(landing.landWebhookArtifacts).not.toHaveBeenCalled();
  });

  it('lands verified artifacts under the extracted repository.full_name and reports accepted', async () => {
    const connector = fakeConnector(async () => [ARTIFACT]);
    const landWebhookArtifacts = vi.fn().mockResolvedValue({ matched: true, landed: 1 });
    const landing = { landWebhookArtifacts } as unknown as WebhookLandingService;
    const controller = new GitHubWebhookController(registryOf(connector), landing);
    const { req: r } = req(payload('acme/orion'));

    await expect(controller.receive(r as never)).resolves.toEqual({ status: 'accepted' });
    expect(landWebhookArtifacts).toHaveBeenCalledWith({
      connectorId: 'github',
      connector,
      externalScopeRef: 'acme/orion',
      artifacts: [ARTIFACT],
    });
  });

  it('reports ignored when no connector_config claims the scope', async () => {
    const connector = fakeConnector(async () => [ARTIFACT]);
    const landing = {
      landWebhookArtifacts: vi.fn().mockResolvedValue({ matched: false, landed: 0 }),
    } as unknown as WebhookLandingService;
    const controller = new GitHubWebhookController(registryOf(connector), landing);
    const { req: r } = req(payload('acme/unclaimed'));
    await expect(controller.receive(r as never)).resolves.toEqual({ status: 'ignored' });
  });

  it('passes headers + raw bytes through to handleWebhook unchanged', async () => {
    const handleWebhook = vi.fn<Connector['handleWebhook']>(async () => []);
    const connector = fakeConnector(handleWebhook);
    const landing = { landWebhookArtifacts: vi.fn() } as unknown as WebhookLandingService;
    const controller = new GitHubWebhookController(registryOf(connector), landing);
    const raw = payload('acme/orion');
    await controller.receive({
      headers: {
        'x-hub-signature-256': 'sha256=sig-value',
        'x-github-event': 'pull_request',
        'content-type': 'application/json',
      },
      rawBody: raw,
    } as unknown as never);

    const call = handleWebhook.mock.calls[0]![0] as ConnectorWebhookRequest;
    expect(call.headers['x-hub-signature-256']).toBe('sha256=sig-value');
    expect(call.headers['x-github-event']).toBe('pull_request');
    expect(call.rawBody).toBe(raw);
    expect(call.connectorId).toBe('github');
  });
});
