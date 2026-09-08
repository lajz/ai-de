import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WorkOS } from '@workos-inc/node';

import type { Env } from '../config/env.js';
import type { SsoAuthResult, WorkOsEvent, WorkOsPort } from './workos.types.js';

/**
 * Live WorkOS adapter. Bound as the `WORKOS` provider only when `WORKOS_API_KEY`
 * is set (see `AuthModule`); otherwise `FakeWorkOsService` is used and none of
 * this code runs. AuthKit is the hosted login (SAML/OIDC/password behind it).
 */
@Injectable()
export class WorkOsService implements WorkOsPort {
  private readonly workos: WorkOS;
  private readonly clientId: string;
  private readonly redirectUri: string;
  private readonly webhookSecret: string;

  constructor(config: ConfigService<Env, true>) {
    const apiKey = config.get('WORKOS_API_KEY', { infer: true });
    const clientId = config.get('WORKOS_CLIENT_ID', { infer: true });
    const redirectUri = config.get('WORKOS_REDIRECT_URI', { infer: true });
    const webhookSecret = config.get('WORKOS_WEBHOOK_SECRET', { infer: true });
    if (!apiKey || !clientId || !redirectUri || !webhookSecret) {
      // AuthModule only constructs this class when WORKOS_API_KEY is present; the
      // rest are still guarded so a partial config fails loudly at boot.
      throw new Error(
        'WorkOsService needs WORKOS_API_KEY, WORKOS_CLIENT_ID, WORKOS_REDIRECT_URI and WORKOS_WEBHOOK_SECRET',
      );
    }
    this.workos = new WorkOS(apiKey, { clientId });
    this.clientId = clientId;
    this.redirectUri = redirectUri;
    this.webhookSecret = webhookSecret;
  }

  authorizationUrl(state?: string): string {
    return this.workos.userManagement.getAuthorizationUrl({
      provider: 'authkit',
      clientId: this.clientId,
      redirectUri: this.redirectUri,
      state,
    });
  }

  async authenticateWithCode(code: string): Promise<SsoAuthResult> {
    const res = await this.workos.userManagement.authenticateWithCode({
      clientId: this.clientId,
      code,
    });
    return {
      user: {
        id: res.user.id,
        email: res.user.email,
        firstName: res.user.firstName,
        lastName: res.user.lastName,
      },
      organizationId: res.organizationId ?? null,
    };
  }

  async verifyEvent(rawBody: string, signatureHeader: string | undefined): Promise<WorkOsEvent> {
    if (!signatureHeader) throw new UnauthorizedException('missing WorkOS signature header');
    try {
      const event = await this.workos.webhooks.constructEvent({
        payload: JSON.parse(rawBody) as Record<string, unknown>,
        sigHeader: signatureHeader,
        secret: this.webhookSecret,
        // reject replays: signature timestamp must be within 5 minutes
        tolerance: 300,
      });
      return { id: event.id, event: event.event, data: event.data as Record<string, unknown> };
    } catch (err) {
      throw new UnauthorizedException(
        `WorkOS webhook verification failed: ${(err as Error).message}`,
      );
    }
  }
}
