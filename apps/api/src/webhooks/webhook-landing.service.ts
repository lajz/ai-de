import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type {
  Connector,
  ConnectorContext,
  ConnectorCredential,
  EngagementId,
  RawArtifact,
  TenantId,
} from '@fde/core';
import { effectiveRetention } from '@fde/core';
import { decryptRow, getCipher, type KeyProvider } from '@fde/crypto';
import { loadNangoClient, type NangoClient } from '@fde/connectors';
import {
  CRYPTO_COLUMNS,
  selectConnectorConfigByScopeRef,
  selectConnectorConfigs,
  selectEngagementRetentionPolicy,
  withEngagement,
  type Database,
} from '@fde/db';
import {
  addTally,
  landConnectorArtifactWithGraph,
  ZERO_TALLY,
  type GraphWriteTally,
} from '@fde/identity';

import { DB } from '../db/db.module.js';
import { KEY_PROVIDER } from '../key-provider/key-provider.module.js';
import { TemporalAgenticLinking } from '../temporal/temporal.module.js';

export interface LandWebhookArtifactsInput {
  connectorId: string;
  /** built by the caller (route-resolved id, never read from the payload) */
  connector: Connector;
  /** the verified payload's external scope key (a Linear organization id) */
  externalScopeRef: string;
  artifacts: RawArtifact[];
}

export interface LandWebhookArtifactsResult {
  /** false when no `connector_config` row claims `externalScopeRef` for this connector */
  matched: boolean;
  /** `sources` rows newly inserted (dedupe hits excluded) */
  landed: number;
  /** canonical-graph write tally (metadata only) — see `GraphWriteTally` */
  graph: GraphWriteTally;
}

/**
 * Resolves the connector's runtime credential and turns each verified
 * `RawArtifact` from a webhook into a durable `sources` row **and** the
 * canonical graph write (`landConnectorArtifactWithGraph`, `@fde/identity`),
 * both inside one engagement transaction — the same
 * dedupe/encryption/ACL/graph discipline `apps/workers`' `ConnectorSync`
 * activity uses, so a live webhook delivery updates the graph immediately
 * instead of waiting for the next poll. Connector-agnostic, so a future
 * connector's webhook controller is the only new code it needs.
 */
@Injectable()
export class WebhookLandingService {
  private readonly logger = new Logger(WebhookLandingService.name);
  private readonly nango: NangoClient;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(KEY_PROVIDER) private readonly keyProvider: KeyProvider,
    // Optional: tests that construct this service directly (bypassing Nest DI)
    // pass only the first two args, and get the best-effort no-trigger behavior
    // below — same as Temporal being unconfigured in a real deployment.
    @Optional() private readonly agenticLinking?: TemporalAgenticLinking,
  ) {
    // Same config flip as `@fde/workers` / `createDefaultConnectorRegistry`:
    // real `HttpNangoClient` when `NANGO_SECRET_KEY` is set, `FakeNangoClient`
    // otherwise — so the receiver runs end to end without a Nango server.
    this.nango = loadNangoClient(process.env);
  }

  async landWebhookArtifacts(
    input: LandWebhookArtifactsInput,
  ): Promise<LandWebhookArtifactsResult> {
    const match = await selectConnectorConfigByScopeRef(
      this.db,
      input.connectorId,
      input.externalScopeRef,
    );
    if (!match) {
      // Not an attack — an unconfigured (or since-unclaimed) workspace sending
      // webhooks is expected. Log a structured event and discard quietly; the
      // controller turns this into a 200.
      this.logger.log(
        `webhook.${input.connectorId}.unmatched_scope no connector_config claims this scope`,
      );
      return { matched: false, landed: 0, graph: ZERO_TALLY };
    }
    if (input.artifacts.length === 0) return { matched: true, landed: 0, graph: ZERO_TALLY };

    const { tenantId, engagementId } = match;

    // One short transaction: read the engagement's effective retention policy
    // and decrypt `credentialRef`. Kept separate from the Nango exchange +
    // `resolveAcl` below (both network calls) so neither holds the
    // `withEngagement` `FOR SHARE` lock — same split `ConnectorSync`'s
    // `makeGetCredential` / `loadConnectorCredentialRef` use.
    const { retentionPolicy, credentialRef } = await withEngagement(
      this.db,
      this.keyProvider,
      { tenantId, engagementId },
      async (tx) => {
        const basePolicy =
          (await selectEngagementRetentionPolicy(tx, tenantId, engagementId)) ?? 'full-retention';
        const cfg = (await selectConnectorConfigs(tx, tenantId, engagementId)).find(
          (c) => c.connector === input.connectorId,
        );
        const policy = effectiveRetention(input.connectorId, cfg?.retentionOverride ?? basePolicy);
        if (!cfg?.credentialRef) return { retentionPolicy: policy, credentialRef: null };
        const decrypted = await decryptRow<{ credentialRef: string }>(
          getCipher(),
          CRYPTO_COLUMNS.connector_config,
          { credentialRef: cfg.credentialRef },
        );
        return { retentionPolicy: policy, credentialRef: decrypted.credentialRef };
      },
    );

    // Nango exchange (network) and `resolveAcl` (network, for Linear) both run
    // outside any transaction — mirrors `ConnectorSync.ingestArtifact`.
    const credential = await resolveWebhookCredential(
      input.connector,
      credentialRef,
      this.nango,
      input.connectorId,
    );
    const ctx: ConnectorContext = {
      tenantId,
      engagementId,
      getCredential: () => Promise.resolve(credential),
      log: (event, fields) =>
        this.logger.log(`webhook.${input.connectorId}.${event}`, JSON.stringify(fields ?? {})),
      // One-shot request-scoped call, nothing to cancel — never aborted.
      signal: new AbortController().signal,
    };

    let landed = 0;
    let graph: GraphWriteTally = { ...ZERO_TALLY };
    for (const artifact of input.artifacts) {
      const aclSnapshot = await input.connector.resolveAcl(ctx, artifact);
      const result = await landConnectorArtifactWithGraph(this.db, this.keyProvider, {
        tenantId,
        engagementId,
        connectorId: input.connectorId,
        retentionPolicy,
        artifact,
        aclSnapshot,
        connector: input.connector,
      });
      if (result.inserted) landed += 1;
      graph = addTally(graph, result.graph);
      for (const workItemEntityId of result.graph.newWorkItemEntityIds) {
        this.triggerAgenticLinking(tenantId, engagementId, workItemEntityId, result.sourceId);
      }
    }
    // metadata-only: counts, never entity names / refs / bodies
    this.logger.log(
      `webhook.${input.connectorId}.graph_persisted`,
      JSON.stringify({ ...graph, connectorId: input.connectorId }),
    );
    return { matched: true, landed, graph };
  }

  /**
   * Best-effort, fire-and-forget start of `AgenticLinkingPipeline` for one
   * newly-created work item. Deliberately not `await`ed by the caller: this is
   * an enhancement layered on top of a webhook delivery whose own durability
   * contract (dedupe, the graph write, the HTTP response) already succeeded by
   * the time this is called — a slow or unreachable Temporal must never hold
   * up, or fail, the webhook response. Every failure (Temporal unconfigured,
   * unreachable, a duplicate-start on a redelivered webhook) is caught and
   * logged, never thrown.
   */
  private triggerAgenticLinking(
    tenantId: TenantId,
    engagementId: EngagementId,
    workItemEntityId: string,
    sourceId: string,
  ): void {
    if (!this.agenticLinking) return;
    this.agenticLinking
      .start({ tenantId, engagementId, workItemEntityId, sourceId })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`webhook.agentic_linking_not_started ${message}`);
      });
  }
}

/**
 * The same decision `ConnectorSync`'s `makeGetCredential` makes, once, for a
 * single webhook-delivered artifact: a `nango-oauth` connector exchanges the
 * stored Nango connection id for a fresh access token; anything else uses the
 * decrypted `credentialRef` as-is. Throws (→ an unhandled 500, so Linear's own
 * webhook retry-on-5xx applies) when the engagement claimed this scope but
 * never attached a working credential — same "missing credential" failure
 * `ConnectorSync` raises as a retryable `ApplicationFailure`.
 */
async function resolveWebhookCredential(
  connector: Connector,
  credentialRef: string | null,
  nango: NangoClient,
  connectorId: string,
): Promise<ConnectorCredential> {
  if (connector.authKind === 'nango-oauth') {
    if (!credentialRef) {
      throw new Error(`connector '${connectorId}' has no Nango connection id for this engagement`);
    }
    const connection = await nango.getConnection(credentialRef, connectorId);
    return {
      authKind: 'nango-oauth',
      value: connection.accessToken,
      ...(Object.keys(connection.metadata).length > 0 ? { metadata: connection.metadata } : {}),
    };
  }
  if (!credentialRef) {
    throw new Error(`connector '${connectorId}' has no stored credential for this engagement`);
  }
  return { authKind: connector.authKind, value: credentialRef };
}
