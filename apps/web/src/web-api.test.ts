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
    const fetchMock = vi.fn(async () => okJson([{ id: 'f1', citations: [] }]));
    vi.stubGlobal('fetch', fetchMock);

    const facts = await getFacts('tok', 'eng-1');

    expect(facts).toEqual([{ id: 'f1', citations: [] }]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/engagements\/eng-1\/facts$/);
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
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
