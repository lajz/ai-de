import { describe, expect, it } from 'vitest';

import { FakeEmbeddingClient } from './fake.js';
import { EMBEDDING_DIM } from './types.js';

describe('EMBEDDING_DIM', () => {
  it('is 1024 (matches @fde/db embeddings.embedding vector(1024))', () => {
    expect(EMBEDDING_DIM).toBe(1024);
  });
});

describe('FakeEmbeddingClient', () => {
  const client = new FakeEmbeddingClient();

  it('returns one vector of dim length per input', async () => {
    const [a, b] = await client.embed(['hello', 'world']);
    expect(client.dim).toBe(1024);
    expect(a).toHaveLength(1024);
    expect(b).toHaveLength(1024);
  });

  it('is deterministic — same text yields an identical vector', async () => {
    const [first] = await client.embed(['the quick brown fox']);
    const [second] = await new FakeEmbeddingClient().embed(['the quick brown fox']);
    expect(second).toEqual(first);
  });

  it('distinguishes different texts', async () => {
    const [a, b] = await client.embed(['alpha', 'beta']);
    expect(a).not.toEqual(b);
  });

  it('produces unit-norm vectors', async () => {
    const [v] = await client.embed(['normalize me']);
    const norm = Math.sqrt(v!.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it('honours a custom dimension', async () => {
    const [v] = await new FakeEmbeddingClient(256).embed(['x']);
    expect(v).toHaveLength(256);
  });
});
