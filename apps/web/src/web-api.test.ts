import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, askQuestion, getFacts } from './lib/api';
import { safeHttpUrl } from './lib/url';

vi.mock('./lib/session', () => ({ getSessionToken: vi.fn(async () => 'tok-from-cookie') }));

const okJson = (data: unknown, ok = true, status = 200) =>
  ({ ok, status, json: async () => data }) as Response;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('lib/api', () => {
  it('getFacts hits the engagement facts route with a bearer token', async () => {
    const fetchMock = vi.fn(async () => okJson({ rows: [{ id: 'f1', citations: [] }] }));
    vi.stubGlobal('fetch', fetchMock);

    const page = await getFacts('tok', 'eng-1');

    expect(page).toEqual({ rows: [{ id: 'f1', citations: [] }] });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/engagements\/eng-1\/facts$/);
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('getFacts forwards limit + cursor as query params', async () => {
    const fetchMock = vi.fn(async () => okJson({ rows: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await getFacts('tok', 'eng-1', { limit: 10, cursor: 'abc' });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/engagements\/eng-1\/facts\?limit=10&cursor=abc$/);
  });

  it('askQuestion POSTs the question and throws ApiError on a non-2xx', async () => {
    const fetchMock = vi.fn(async () => okJson({ answer: 'a', citations: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await askQuestion('tok', 'eng-1', 'why postgres?');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/engagements\/eng-1\/qa$/);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ question: 'why postgres?' });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson({}, false, 403)),
    );
    await expect(askQuestion('tok', 'e', 'q')).rejects.toBeInstanceOf(ApiError);
  });
});

describe('GET /api/facts proxy', () => {
  async function get(qs: string) {
    const { GET } = await import('./app/api/facts/route');
    return GET(new Request(`http://localhost/api/facts?${qs}`));
  }

  it('rejects a request missing engagementId', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect((await get('cursor=abc')).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric limit', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect((await get('engagementId=e&limit=nope')).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards cursor + limit and relays the upstream page / a 403', async () => {
    const fetchMock = vi.fn(async () => okJson({ rows: [{ id: 'f1' }], nextCursor: 'next' }));
    vi.stubGlobal('fetch', fetchMock);
    const ok = await get('engagementId=e&limit=10&cursor=abc');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ rows: [{ id: 'f1' }], nextCursor: 'next' });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('limit=10');
    expect(url).toContain('cursor=abc');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson({}, false, 403)),
    );
    const denied = await get('engagementId=e');
    expect(denied.status).toBe(403);
  });
});

describe('safeHttpUrl', () => {
  it('passes http(s) through and rejects other schemes / junk', () => {
    expect(safeHttpUrl('https://ex.com/t/1')).toBe('https://ex.com/t/1');
    expect(safeHttpUrl('http://ex.com')).toBe('http://ex.com');
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('data:text/html,x')).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
    expect(safeHttpUrl('not a url')).toBeNull();
  });
});

describe('POST /api/qa proxy', () => {
  async function post(body: unknown) {
    const { POST } = await import('./app/api/qa/route');
    return POST(
      new Request('http://localhost/api/qa', { method: 'POST', body: JSON.stringify(body) }),
    );
  }

  it('validates the body before calling the API', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect((await post({ question: 'q' })).status).toBe(400); // missing engagementId
    expect((await post({ engagementId: 'e', question: '  ' })).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards a valid question to the API and relays the answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        okJson({
          answer: 'Postgres.',
          citations: [{ sourceId: 's', permalink: 'https://x', quote: 'q' }],
        }),
      ),
    );

    const res = await post({ engagementId: 'eng-1', question: 'which db?' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ answer: 'Postgres.' });
  });
});
