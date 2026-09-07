import { EmbeddingDimError, EmbeddingRequestError } from '../errors.js';
import { EMBEDDING_DIM, type EmbeddingClient } from './types.js';

export interface VoyageConfig {
  apiKey?: string;
  /** Default `voyage-3.5` (native 1024-dim, no-retention DPA). */
  model?: string;
  /** Default `https://api.voyageai.com/v1`. */
  baseUrl?: string;
  /** Voyage output dimension. Default `EMBEDDING_DIM` (1024). */
  outputDimension?: number;
  /** `document` (default) for stored chunks, `query` for retrieval-time queries. */
  inputType?: 'document' | 'query';
  /** Test seam. */
  fetchImpl?: typeof fetch;
}

interface VoyageResponse {
  data?: { embedding?: number[]; index?: number }[];
  usage?: { total_tokens?: number };
}

/**
 * Voyage AI embeddings (T0). Behind `EmbeddingClient` so a self-hosted backend
 * replaces it for regulated / T1 without touching callers.
 */
export class VoyageEmbeddingClient implements EmbeddingClient {
  readonly model: string;
  readonly dim: number;
  private readonly config: VoyageConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(config: VoyageConfig = {}) {
    this.config = config;
    this.model = config.model ?? 'voyage-3.5';
    this.dim = config.outputDimension ?? EMBEDDING_DIM;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const baseUrl = (this.config.baseUrl ?? 'https://api.voyageai.com/v1').replace(/\/+$/, '');
    const res = await this.fetchImpl(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        input: texts,
        model: this.model,
        output_dimension: this.dim,
        input_type: this.config.inputType ?? 'document',
      }),
    });
    if (!res.ok) {
      // Status only — the response body can echo the (sensitive) input text, and
      // this platform never lets content reach a log line.
      throw new EmbeddingRequestError(res.status, res.statusText || 'request failed');
    }
    const data = (await res.json()) as VoyageResponse;
    const rows = data.data;
    if (!rows || rows.length !== texts.length) {
      throw new EmbeddingRequestError(
        res.status,
        `expected ${texts.length} vectors, got ${rows?.length ?? 0}`,
      );
    }
    const ordered = [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return ordered.map((row) => {
      const vec = row.embedding ?? [];
      if (vec.length !== this.dim) throw new EmbeddingDimError(this.dim, vec.length);
      return vec;
    });
  }
}
