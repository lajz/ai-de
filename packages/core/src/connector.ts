import type { CanonicalRecord } from './canonical.js';
import type { EngagementId, TenantId } from './ids.js';
import type { AclSnapshot } from './provenance.js';
import type { RawArtifact } from './raw-artifact.js';
import type { RetentionPolicy } from './retention.js';
import type { SyncCursor, SyncEmit } from './sync.js';

export const CONNECTOR_AUTH_KINDS = ['nango-oauth', 'bearer', 'mcp-oauth', 'inbound-push'] as const;
export type ConnectorAuthKind = (typeof CONNECTOR_AUTH_KINDS)[number];

export interface ConnectorCredential {
  authKind: ConnectorAuthKind;
  /** decrypted secret — a Nango connection id, a bearer token, etc. */
  value: string;
  metadata?: Record<string, string>;
}

export interface ConnectorContext {
  tenantId: TenantId;
  engagementId: EngagementId;
  /** fetches a credential for this connector + engagement from the vault */
  getCredential: () => Promise<ConnectorCredential>;
  /** structured log sink — MUST NOT be passed artifact bodies */
  log: (event: string, fields?: Record<string, unknown>) => void;
  /** cancellation for long-running backfills */
  signal: AbortSignal;
}

export interface ConnectorWebhookRequest {
  headers: Readonly<Record<string, string>>;
  rawBody: Uint8Array;
  /** connector id resolved from the route — never read from the payload */
  connectorId: string;
}

/**
 * The one interface every integration implements — built-in (on Nango or a direct
 * client) and, later, customer-authored. Transport and auth vary; this contract
 * does not.
 */
export interface Connector {
  readonly id: string;
  readonly authKind: ConnectorAuthKind;
  readonly retentionPolicy: RetentionPolicy;

  /** Full historical import. Must yield in a stable order and checkpoint often. */
  backfill(ctx: ConnectorContext): AsyncIterable<SyncEmit>;

  /** Everything changed since `cursor` (null = from the start of incremental). */
  incremental(ctx: ConnectorContext, cursor: SyncCursor | null): AsyncIterable<SyncEmit>;

  /** Parse a provider webhook into artifacts. May return an empty array. */
  handleWebhook(req: ConnectorWebhookRequest): Promise<RawArtifact[]>;

  /** Compute the origin-system ACL for an artifact. */
  resolveAcl(ctx: ConnectorContext, artifact: RawArtifact): Promise<AclSnapshot>;

  /** Map an artifact to canonical graph records. Pure — no I/O. */
  normalize(artifact: RawArtifact): CanonicalRecord[];
}
