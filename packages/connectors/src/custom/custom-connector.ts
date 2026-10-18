import {
  buildCustomRawArtifact,
  effectiveRetention,
  normalizeCustomArtifact,
  type AclSnapshot,
  type CanonicalRecord,
  type Connector,
  type ConnectorContext,
  type ConnectorWebhookRequest,
  type CustomIntegrationMapping,
  type RawArtifact,
  type RetentionPolicy,
  type SyncEmit,
} from '@fde/core';

export const CUSTOM_CONNECTOR_PREFIX = 'custom:';
export const CUSTOM_ACL_TTL_SECONDS = 86_400;

/** The pushed body was not a JSON object — a client error, not a mapping error. */
export class CustomPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CustomPayloadError';
  }
}

export interface CustomWebhookConnectorOptions {
  integrationId: string;
  mapping: CustomIntegrationMapping;
  /** passes through `effectiveRetention` like every other connector */
  engagementRetentionPolicy: RetentionPolicy;
}

async function* none(): AsyncIterable<SyncEmit> {}

/**
 * A customer-defined, **push-only** connector driven entirely by a declarative
 * field mapping. Not in `ConnectorRegistry`: the ingest controller builds one
 * per request from a `custom_integrations` row. `id` embeds the integration id
 * so two integrations' external refs never collide.
 */
export class CustomWebhookConnector implements Connector {
  readonly id: string;
  readonly authKind = 'inbound-push' as const;
  readonly retentionPolicy: RetentionPolicy;

  private readonly mapping: CustomIntegrationMapping;

  constructor(options: CustomWebhookConnectorOptions) {
    this.id = `${CUSTOM_CONNECTOR_PREFIX}${options.integrationId}`;
    this.mapping = options.mapping;
    this.retentionPolicy = effectiveRetention(this.id, options.engagementRetentionPolicy);
  }

  backfill(_ctx?: ConnectorContext): AsyncIterable<SyncEmit> {
    return none();
  }

  incremental(_ctx?: ConnectorContext): AsyncIterable<SyncEmit> {
    return none();
  }

  /** Throws `CustomPayloadError` (bad JSON/shape) or `CustomMappingValidationError`. */
  async handleWebhook(req: ConnectorWebhookRequest): Promise<RawArtifact[]> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(req.rawBody));
    } catch {
      throw new CustomPayloadError('body is not valid JSON');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new CustomPayloadError('payload must be a JSON object');
    }
    return [
      buildCustomRawArtifact(this.mapping.artifact, this.id, parsed as Record<string, unknown>),
    ];
  }

  /**
   * No origin-system ACL exists to capture. Empty rules = visibility governed
   * by engagement membership alone (the same fallback Granola uses).
   */
  async resolveAcl(_ctx?: ConnectorContext, _artifact?: RawArtifact): Promise<AclSnapshot> {
    return { rules: [], capturedAt: new Date().toISOString(), ttlSeconds: CUSTOM_ACL_TTL_SECONDS };
  }

  normalize(artifact: RawArtifact): CanonicalRecord[] {
    return normalizeCustomArtifact(this.mapping, this.id, artifact.raw ?? {}, { strict: true })
      .records;
  }
}
