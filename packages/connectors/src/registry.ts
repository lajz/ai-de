import { type Connector, type RetentionPolicy } from '@fde/core';

import { GranolaConnector } from './granola/granola-connector.js';
import { loadGranolaClient } from './granola/load-granola-client.js';
import { LinearConnector } from './linear/linear-connector.js';
import { loadLinearClientFactory } from './linear/load-linear-client.js';

export interface ConnectorBuildContext {
  /** the engagement's retention policy — a connector derives its effective policy from it */
  engagementRetentionPolicy: RetentionPolicy;
}

/** Builds a fresh `Connector` for one sync run (bound to that engagement's retention policy). */
export type ConnectorFactory = (ctx: ConnectorBuildContext) => Connector;

/**
 * Maps a connector id to its factory. Reused by every connector-driven Temporal
 * workflow (`ConnectorSync` for M2 Granola, M3 Linear, …) — the workflow's
 * activity deps carry one of these, built once in `worker.ts`.
 */
export class ConnectorRegistry {
  constructor(private readonly factories: Readonly<Record<string, ConnectorFactory>>) {}

  has(id: string): boolean {
    return id in this.factories;
  }

  /** Ids of every registered connector. */
  get ids(): string[] {
    return Object.keys(this.factories);
  }

  /** Build the connector for `id`, or throw if none is registered. */
  build(id: string, ctx: ConnectorBuildContext): Connector {
    const factory = this.factories[id];
    if (!factory)
      throw new Error(`no connector registered for '${id}' (have: ${this.ids.join(', ')})`);
    return factory(ctx);
  }
}

/**
 * The default registry:
 *
 * - **Granola** — backed by `loadGranolaClient(env)` (real `HttpGranolaClient`
 *   when `GRANOLA_API_KEY` is set, `FakeGranolaClient` otherwise). One shared
 *   client instance across sync runs.
 * - **Linear** — `authKind: 'nango-oauth'`; its bearer token is minted per run
 *   by self-hosted Nango via `ConnectorContext.getCredential` (wired in
 *   `apps/workers`). `loadLinearClientFactory(env)` selects `HttpLinearClient`
 *   when `NANGO_SECRET_KEY` is set, `FakeLinearClient` otherwise.
 */
export function createDefaultConnectorRegistry(env: NodeJS.ProcessEnv): ConnectorRegistry {
  const granolaClient = loadGranolaClient(env);
  const linearClientFactory = loadLinearClientFactory(env);
  return new ConnectorRegistry({
    granola: (ctx) =>
      new GranolaConnector({
        client: granolaClient,
        engagementRetentionPolicy: ctx.engagementRetentionPolicy,
      }),
    linear: (ctx) =>
      new LinearConnector({
        clientFactory: linearClientFactory,
        engagementRetentionPolicy: ctx.engagementRetentionPolicy,
        ...(env.LINEAR_WEBHOOK_SECRET ? { webhookSecret: env.LINEAR_WEBHOOK_SECRET } : {}),
      }),
  });
}
