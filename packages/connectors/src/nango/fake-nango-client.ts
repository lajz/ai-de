import { type NangoClient, type NangoConnection } from './nango-client.js';

export interface FakeNangoOptions {
  /** the token every `getConnection` returns (default `'fake-nango-access-token'`) */
  accessToken?: string;
  /** metadata returned for every connection */
  metadata?: Record<string, string>;
  /** connection ids that should 404 — `getConnection` rejects for these */
  unknownConnectionIds?: string[];
}

/**
 * Dependency-free `NangoClient`. No network: returns a deterministic canned
 * token for any connection id (so a `nango-oauth` connector + the
 * `ConnectorSync` workflow run end to end without a Nango server), and records
 * every call so a test can assert the connector fetched a fresh token per run.
 */
export class FakeNangoClient implements NangoClient {
  private readonly accessToken: string;
  private readonly metadata: Record<string, string>;
  private readonly unknown: Set<string>;
  /** `[connectionId, providerConfigKey]` for every `getConnection` call */
  readonly calls: Array<[string, string]> = [];

  constructor(options: FakeNangoOptions = {}) {
    this.accessToken = options.accessToken ?? 'fake-nango-access-token';
    this.metadata = options.metadata ?? { workspace: 'ws-fake' };
    this.unknown = new Set(options.unknownConnectionIds ?? []);
  }

  async getConnection(connectionId: string, providerConfigKey: string): Promise<NangoConnection> {
    this.calls.push([connectionId, providerConfigKey]);
    if (this.unknown.has(connectionId)) {
      throw new Error(`FakeNangoClient: no connection '${connectionId}'`);
    }
    return {
      accessToken: this.accessToken,
      expiresAt: '2099-01-01T00:00:00.000Z',
      metadata: { ...this.metadata },
    };
  }
}
