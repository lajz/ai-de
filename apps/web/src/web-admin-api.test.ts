import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  getConnectors,
  getGraph,
  getPipeline,
  putConnector,
  startConnectorSync,
} from './lib/api';

vi.mock('./lib/session', () => ({ getSessionToken: vi.fn(async () => 'tok-from-cookie') }));

const okJson = (data: unknown, ok = true, status = 200) =>
  ({ ok, status, json: async () => data }) as Response;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('lib/api — /admin client', () => {
  it('getConnectors GETs the connectors route with a bearer token', async () => {
    const fetchMock = vi.fn(async () => okJson([{ connector: 'granola' }]));
    vi.stubGlobal('fetch', fetchMock);

    await getConnectors('tok', 'eng-1');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/engagements\/eng-1\/connectors$/);
    expect(init.method ?? 'GET').toBe('GET');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('putConnector PUTs the patch body', async () => {
    const fetchMock = vi.fn(async () => okJson({ connector: 'granola', enabled: true }));
    vi.stubGlobal('fetch', fetchMock);

    await putConnector('tok', 'eng-1', 'granola', { enabled: true, retentionOverride: null });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/engagements\/eng-1\/connectors\/granola$/);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ enabled: true, retentionOverride: null });
  });

  it('startConnectorSync POSTs { mode }', async () => {
    const fetchMock = vi.fn(async () => okJson({ workflowId: 'wf-1' }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await startConnectorSync('tok', 'eng-1', 'granola', 'backfill');
    expect(res).toEqual({ workflowId: 'wf-1' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/connectors\/granola\/sync$/);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ mode: 'backfill' });
  });

  it('getGraph encodes entityType / predicate filters', async () => {
    const fetchMock = vi.fn(async () => okJson({ nodes: [], edges: [], truncated: false }));
    vi.stubGlobal('fetch', fetchMock);

    await getGraph('tok', 'eng-1', { entityType: 'person', predicate: 'attends' });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('/engagements/eng-1/graph?');
    expect(url).toContain('entityType=person');
    expect(url).toContain('predicate=attends');

    await getGraph('tok', 'eng-1');
    expect((fetchMock.mock.calls[1] as [string])[0]).toMatch(/\/graph$/);
  });

  it('getPipeline appends a positive limit only', async () => {
    const fetchMock = vi.fn(async () =>
      okJson({ syncStates: [], recentExtractionRuns: [], rollups: {} }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await getPipeline('tok', 'eng-1', 5);
    expect((fetchMock.mock.calls[0] as [string])[0]).toMatch(/\/pipeline\?limit=5$/);
    await getPipeline('tok', 'eng-1');
    expect((fetchMock.mock.calls[1] as [string])[0]).toMatch(/\/pipeline$/);
  });

  it('maps a non-2xx to ApiError carrying the status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson({}, false, 403)),
    );
    await expect(getConnectors('tok', 'e')).rejects.toBeInstanceOf(ApiError);
  });
});

describe('PUT /api/admin/connectors proxy', () => {
  async function put(body: unknown) {
    const { PUT } = await import('./app/api/admin/connectors/route');
    return PUT(
      new Request('http://localhost/api/admin/connectors', {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    );
  }

  it('rejects a body missing engagementId or connectorId', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect((await put({ connectorId: 'granola' })).status).toBe(400);
    expect((await put({ engagementId: 'e' })).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards the patch and passes an upstream 403 through', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson({ connector: 'granola', enabled: false })),
    );
    const ok = await put({ engagementId: 'e', connectorId: 'granola', enabled: false });
    expect(ok.status).toBe(200);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson({}, false, 403)),
    );
    const denied = await put({ engagementId: 'e', connectorId: 'granola', enabled: true });
    expect(denied.status).toBe(403);
  });
});

describe('POST /api/admin/sync proxy', () => {
  async function post(body: unknown) {
    const { POST } = await import('./app/api/admin/sync/route');
    return POST(
      new Request('http://localhost/api/admin/sync', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    );
  }

  it('validates mode', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect((await post({ engagementId: 'e', connectorId: 'granola', mode: 'nope' })).status).toBe(
      400,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('relays a 409 / 503 with a human-readable message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson({}, false, 409)),
    );
    const conflict = await post({ engagementId: 'e', connectorId: 'granola', mode: 'backfill' });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: expect.stringContaining('credential') });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson({}, false, 503)),
    );
    const unavailable = await post({
      engagementId: 'e',
      connectorId: 'granola',
      mode: 'incremental',
    });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ error: expect.stringContaining('Temporal') });
  });
});
