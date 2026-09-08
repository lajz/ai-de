/**
 * The thin WorkOS seam. Everything the API needs from WorkOS goes through
 * `WorkOsPort`; `WorkOsService` implements it against `@workos-inc/node` and
 * `FakeWorkOsService` implements it in memory for dev/test. The rest of the app
 * depends only on this interface (`WORKOS` token).
 */
export interface WorkOsUser {
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
}

export interface SsoAuthResult {
  user: WorkOsUser;
  /** WorkOS organization id — mapped to a tenant via `WORKOS_ORG_TENANT_MAP` */
  organizationId: string | null;
}

/** A verified WorkOS webhook event (Directory Sync / SSO). */
export interface WorkOsEvent {
  id: string;
  event: string;
  data: Record<string, unknown>;
}

export interface WorkOsPort {
  /** Authorization URL to redirect the browser to for AuthKit / SAML login. */
  authorizationUrl(state?: string): string;

  /** Exchange the `code` from the callback for the authenticated user + org. */
  authenticateWithCode(code: string): Promise<SsoAuthResult>;

  /**
   * Verify a webhook's signature against `WORKOS_WEBHOOK_SECRET` and return the
   * parsed event. Rejects if the signature is missing or invalid.
   */
  verifyEvent(rawBody: string, signatureHeader: string | undefined): Promise<WorkOsEvent>;
}

export const WORKOS = Symbol('WORKOS');
