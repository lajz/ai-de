import { EMBEDDING_DIM, type EmbeddingClient } from './types.js';

/** FNV-1a 32-bit — cheap, deterministic string hash for seeding the PRNG. */
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
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic, dependency-free `EmbeddingClient` for tests. Same text → same
 * unit vector, always; different text → (almost surely) a different vector. Not
 * semantically meaningful — never use outside tests.
 */
export class FakeEmbeddingClient implements EmbeddingClient {
  readonly dim: number;
  readonly model = 'fake-deterministic';

  constructor(dim: number = EMBEDDING_DIM) {
    this.dim = dim;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.vector(text));
  }

  private vector(text: string): number[] {
    const rand = mulberry32(fnv1a(text));
    const v = new Array<number>(this.dim);
    let norm = 0;
    for (let i = 0; i < this.dim; i++) {
      const x = rand() * 2 - 1;
      v[i] = x;
      norm += x * x;
    }
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < this.dim; i++) v[i]! /= norm;
    return v;
  }
}
