import { createHmac, timingSafeEqual } from 'node:crypto';

import { Injectable, UnauthorizedException } from '@nestjs/common';

import type { SsoAuthResult, WorkOsEvent, WorkOsPort } from './workos.types.js';

const DEFAULT_FAKE_SECRET = 'fake-workos-webhook-secret';

/**
 * In-memory WorkOS stand-in for dev + tests — no network, no `WORKOS_API_KEY`.
 * Bound as the `WORKOS` provider whenever `WORKOS_API_KEY` is unset.
 *
 * Its webhook signature scheme matches WorkOS's real one closely enough to
 * exercise the receiver: header `t=<ms>, v1=<hex hmac>` over `"<t>.<rawBody>"`
 * keyed by the shared secret. `signWebhook` produces a valid header for tests.
 */
@Injectable()
export class FakeWorkOsService implements WorkOsPort {
  private readonly codes = new Map<string, SsoAuthResult>();

  constructor(readonly webhookSecret: string = DEFAULT_FAKE_SECRET) {}

  /** Test helper: make `authenticateWithCode(code)` resolve to `result`. */
  register(code: string, result: SsoAuthResult): void {
    this.codes.set(code, result);
  }

  authorizationUrl(state?: string): string {
    const url = new URL('https://fake-workos.local/sso/authorize');
    url.searchParams.set('client_id', 'fake-client');
    if (state) url.searchParams.set('state', state);
    return url.toString();
  }

  authenticateWithCode(code: string): Promise<SsoAuthResult> {
    const result = this.codes.get(code);
    if (!result) {
      return Promise.reject(new UnauthorizedException(`unknown SSO code: ${code}`));
    }
    return Promise.resolve(result);
  }

  // async so a thrown UnauthorizedException surfaces as a rejected promise
  async verifyEvent(rawBody: string, signatureHeader: string | undefined): Promise<WorkOsEvent> {
    return this.verifyEventSync(rawBody, signatureHeader);
  }

  private verifyEventSync(rawBody: string, signatureHeader: string | undefined): WorkOsEvent {
    if (!signatureHeader) throw new UnauthorizedException('missing WorkOS signature header');

    const parts = Object.fromEntries(
      signatureHeader.split(',').map((p) => {
        const [k, v] = p.split('=');
        return [k?.trim(), v?.trim()] as const;
      }),
    );
    const timestamp = parts.t;
    const provided = parts.v1;
    if (!timestamp || !provided)
      throw new UnauthorizedException('malformed WorkOS signature header');

    const expected = createHmac('sha256', this.webhookSecret)
      .update(`${timestamp}.${rawBody}`)
      .digest('hex');
    const a = Buffer.from(provided, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException('WorkOS webhook signature mismatch');
    }

    const parsed = JSON.parse(rawBody) as Partial<WorkOsEvent>;
    if (!parsed.event || typeof parsed.data !== 'object' || parsed.data === null) {
      throw new UnauthorizedException('WorkOS webhook payload missing event/data');
    }
    return {
      id: parsed.id ?? 'evt_fake',
      event: parsed.event,
      data: parsed.data as Record<string, unknown>,
    };
  }

  /** Build a valid `workos-signature` header for `rawBody`. Test-only. */
  static signWebhook(rawBody: string, secret = DEFAULT_FAKE_SECRET, atMs = Date.now()): string {
    const sig = createHmac('sha256', secret).update(`${atMs}.${rawBody}`).digest('hex');
    return `t=${atMs}, v1=${sig}`;
  }
}
