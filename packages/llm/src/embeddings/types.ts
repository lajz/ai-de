/**
 * Dimension of every vector this platform stores. Must match `@fde/db`'s
 * `EMBEDDING_DIM` and the `embeddings.embedding vector(1024)` column. Changing it
 * is a re-embed migration (plan open-decision #5).
 */
export const EMBEDDING_DIM = 1024;

/**
 * A pluggable embedding backend. `VoyageEmbeddingClient` is T0; a self-hosted
 * BGE/E5 client drops in behind this interface for regulated / T1 (M4) so body
 * text never leaves the data plane.
 */
export interface EmbeddingClient {
  /** Embed each input string. Returns one `dim`-length vector per input, in order. */
  embed(texts: string[]): Promise<number[][]>;
  readonly dim: number;
  readonly model: string;
}
