import { describe, expect, it, vi } from 'vitest';

import {
  EMBEDDING_DIM,
  EmbeddingDimError,
  FakeEmbeddingClient,
  ProviderRequestError,
  VoyageEmbeddingClient,
  createEmbeddingClientFromEnv,
} from './index.js';

const httpJson = (body: unknown, ok = true, status = 200): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: async () => body }) as unknown as Response;

describe('EMBEDDING_DIM', () => {
  it('is 1024 — matches @fde/db embeddings.embedding vector(1024)', () => {
    expect(EMBEDDING_DIM).toBe(1024);
  });
});

describe('FakeEmbeddingClient', () => {
  it('returns one unit-norm vector of dim length per input, deterministically', async () => {
    const [a, b] = await new FakeEmbeddingClient().embed(['alpha', 'beta']);
    expect(a).toHaveLength(1024);
    expect(Math.sqrt(a!.reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 6);
    expect(a).not.toEqual(b);

    const [again] = await new FakeEmbeddingClient().embed(['alpha']);
    expect(again).toEqual(a);
  });

  it('honours a custom dimension', async () => {
    const [v] = await new FakeEmbeddingClient(256).embed(['x']);
    expect(v).toHaveLength(256);
  });
});

describe('VoyageEmbeddingClient (mocked fetch)', () => {
  it('orders vectors by index and pins model + dimension', async () => {
    const fetchImpl = vi.fn(async () =>
      httpJson({
        data: [
          { embedding: Array(1024).fill(0.2), index: 1 },
          { embedding: Array(1024).fill(0.1), index: 0 },
        ],
      }),
    ) as unknown as typeof fetch;

    const out = await new VoyageEmbeddingClient({ apiKey: 'k', fetchImpl }).embed(['a', 'b']);
    expect([out[0]![0], out[1]![0]]).toEqual([0.1, 0.2]);

    const sent = JSON.parse((vi.mocked(fetchImpl).mock.calls[0]![1] as RequestInit).body as string);
    expect(sent).toMatchObject({
      model: 'voyage-3.5',
      output_dimension: 1024,
      input_type: 'document',
    });
  });

  it('rejects a wrong-length vector and a non-2xx response', async () => {
    const dimBad = vi.fn(async () =>
      httpJson({ data: [{ embedding: Array(512).fill(0), index: 0 }] }),
    ) as unknown as typeof fetch;
    await expect(new VoyageEmbeddingClient({ fetchImpl: dimBad }).embed(['a'])).rejects.toThrow(
      EmbeddingDimError,
    );

    const http500 = vi.fn(async () => httpJson({}, false, 500)) as unknown as typeof fetch;
    await expect(new VoyageEmbeddingClient({ fetchImpl: http500 }).embed(['a'])).rejects.toThrow(
      ProviderRequestError,
    );
  });

  it('fails closed when a response row omits its index (would mis-order the batch)', async () => {
    const noIndex = vi.fn(async () =>
      httpJson({
        data: [
          { embedding: Array(1024).fill(0.1), index: 0 },
          { embedding: Array(1024).fill(0.2) },
        ],
      }),
    ) as unknown as typeof fetch;
    await expect(
      new VoyageEmbeddingClient({ fetchImpl: noIndex }).embed(['a', 'b']),
    ).rejects.toThrow(ProviderRequestError);
  });

  it('short-circuits an empty input', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(await new VoyageEmbeddingClient({ fetchImpl }).embed([])).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('createEmbeddingClientFromEnv', () => {
  it('picks Voyage when the key is set, the fake otherwise, and refuses the fake in production', () => {
    expect(createEmbeddingClientFromEnv({ VOYAGE_API_KEY: 'k' })).toBeInstanceOf(
      VoyageEmbeddingClient,
    );

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(createEmbeddingClientFromEnv({})).toBeInstanceOf(FakeEmbeddingClient);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();

    expect(() => createEmbeddingClientFromEnv({ NODE_ENV: 'production' })).toThrow(
      /VOYAGE_API_KEY/,
    );
  });
});

describe.skipIf(!process.env.VOYAGE_API_KEY)('VoyageEmbeddingClient (live)', () => {
  it('embeds real text at dim 1024', async () => {
    const [v] = await new VoyageEmbeddingClient({ apiKey: process.env.VOYAGE_API_KEY }).embed([
      'forward deployed engineering context platform',
    ]);
    expect(v).toHaveLength(1024);
  });
});
