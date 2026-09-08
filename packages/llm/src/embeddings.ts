import { EmbeddingDimError, ProviderRequestError } from './errors.js';

/**
 * Dimension of every vector this platform stores. Must match `@fde/db`'s
 * `EMBEDDING_DIM` / the `embeddings.embedding vector(1024)` column. Changing it
 * is a re-embed migration (plan open-decision #5).
 */
export const EMBEDDING_DIM = 1024;

/**
 * Pluggable embedding backend. `VoyageEmbeddingClient` is T0; a self-hosted
 * BGE/E5 client drops in behind this interface for regulated / T1 (M4) so body
 * text never leaves the data plane.
 */
export interface EmbeddingClient {
  /** One `dim`-length vector per input, in input order. */
  embed(texts: string[]): Promise<number[][]>;
  readonly dim: number;
  readonly model: string;
}

// --- FakeEmbeddingClient (tests) ---------------------------------------------

/** FNV-1a 32-bit — deterministic string hash to seed the PRNG. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — small deterministic PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic, dependency-free `EmbeddingClient` for tests. Same text → same
 * unit vector; different text → (almost surely) a different one. Not
 * semantically meaningful — tests only.
 */
export class FakeEmbeddingClient implements EmbeddingClient {
  readonly model = 'fake-deterministic';
  constructor(readonly dim: number = EMBEDDING_DIM) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const rand = mulberry32(fnv1a(text));
      const v = Array.from({ length: this.dim }, () => rand() * 2 - 1);
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return v.map((x) => x / norm);
    });
  }
}

// --- VoyageEmbeddingClient (T0) --------------------------------------------------

export interface VoyageConfig {
  apiKey?: string;
  /** Default `voyage-3.5` (native 1024-dim, no-retention DPA). */
  model?: string;
  /** Default `https://api.voyageai.com/v1`. */
  baseUrl?: string;
  /** Default `EMBEDDING_DIM` (1024). */
  outputDimension?: number;
  /** `document` (default) for stored chunks, `query` for retrieval queries. */
  inputType?: 'document' | 'query';
  /** Test seam. */
  fetchImpl?: typeof fetch;
}

interface VoyageResponse {
  data?: { embedding?: number[]; index?: number }[];
}

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
    // Status only — an error body can echo the (sensitive) input text, which
    // must never reach a log line on this platform.
    if (!res.ok) throw new ProviderRequestError(res.status, res.statusText || 'request failed');

    const rows = ((await res.json()) as VoyageResponse).data;
    if (!rows || rows.length !== texts.length) {
      throw new ProviderRequestError(
        res.status,
        `expected ${texts.length} vectors, got ${rows?.length ?? 0}`,
      );
    }
    // Voyage returns a per-row `index`; re-sort by it so the vectors line up with
    // `texts`. Fail closed if any row omits it rather than silently coalescing to
    // 0 and mis-ordering the batch.
    if (rows.some((r) => typeof r.index !== 'number')) {
      throw new ProviderRequestError(res.status, 'response row missing a numeric index');
    }
    return [...rows]
      .sort((a, b) => a.index! - b.index!)
      .map((row) => {
        const vec = row.embedding ?? [];
        if (vec.length !== this.dim) throw new EmbeddingDimError(this.dim, vec.length);
        return vec;
      });
  }
}
