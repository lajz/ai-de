import { describe, expect, it, vi } from 'vitest';

import { EmbeddingDimError, EmbeddingRequestError } from '../errors.js';
import { VoyageEmbeddingClient } from './voyage.js';

function voyageResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'ERR',
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  } as unknown as Response;
}

function vec(dim: number, fill: number): number[] {
  return new Array<number>(dim).fill(fill);
}

describe('VoyageEmbeddingClient (mocked fetch)', () => {
  it('returns vectors ordered by index and sends the pinned dimension', async () => {
    const fetchImpl = vi.fn(async () =>
      voyageResponse({
        data: [
          { embedding: vec(1024, 0.2), index: 1 },
          { embedding: vec(1024, 0.1), index: 0 },
        ],
        usage: { total_tokens: 8 },
      }),
    ) as unknown as typeof fetch;

    const client = new VoyageEmbeddingClient({ apiKey: 'k', fetchImpl });
    const out = await client.embed(['a', 'b']);
    expect(out[0]![0]).toBe(0.1);
    expect(out[1]![0]).toBe(0.2);

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.voyageai.com/v1/embeddings');
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent).toMatchObject({
      model: 'voyage-3.5',
      output_dimension: 1024,
      input_type: 'document',
    });
  });

  it('throws EmbeddingDimError when a vector is the wrong length', async () => {
    const fetchImpl = vi.fn(async () =>
      voyageResponse({ data: [{ embedding: vec(512, 0), index: 0 }] }),
    ) as unknown as typeof fetch;
    const client = new VoyageEmbeddingClient({ fetchImpl });
    await expect(client.embed(['a'])).rejects.toThrow(EmbeddingDimError);
  });

  it('throws EmbeddingRequestError on a non-2xx response', async () => {
    const fetchImpl = vi.fn(async () =>
      voyageResponse({ detail: 'bad key' }, false, 401),
    ) as unknown as typeof fetch;
    const client = new VoyageEmbeddingClient({ fetchImpl });
    await expect(client.embed(['a'])).rejects.toThrow(EmbeddingRequestError);
  });

  it('short-circuits on an empty input', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(await new VoyageEmbeddingClient({ fetchImpl }).embed([])).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// Live smoke — only runs with a real key.
describe.skipIf(!process.env.VOYAGE_API_KEY)('VoyageEmbeddingClient (live)', () => {
  it('embeds real text at dim 1024', async () => {
    const client = new VoyageEmbeddingClient({ apiKey: process.env.VOYAGE_API_KEY });
    const [v] = await client.embed(['forward deployed engineering context platform']);
    expect(v).toHaveLength(1024);
  });
});
