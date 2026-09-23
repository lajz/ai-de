import { apiBaseUrl } from '../../../../lib/api';
import { getSessionToken } from '../../../../lib/session';

/**
 * Streaming counterpart to `/api/qa`: same-origin proxy that keeps the
 * session token server-side, but instead of buffering a single JSON
 * response, it pipes `@fde/api`'s SSE body straight through to the browser
 * as it arrives — `AskPanel` reads it with `fetch()` + a `ReadableStream`
 * reader (not `EventSource`, which can't send a POST body).
 */
export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const { engagementId, question } = (body ?? {}) as {
    engagementId?: unknown;
    question?: unknown;
  };
  if (typeof engagementId !== 'string' || engagementId === '') {
    return Response.json({ error: 'engagementId is required' }, { status: 400 });
  }
  if (typeof question !== 'string' || question.trim() === '') {
    return Response.json({ error: 'question is required' }, { status: 400 });
  }

  const token = await getSessionToken();
  let upstream: Response;
  try {
    upstream = await fetch(`${apiBaseUrl()}/engagements/${engagementId}/qa/agentic`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ question }),
      cache: 'no-store',
    });
  } catch (err) {
    console.error(`POST /api/qa/agentic → upstream request failed: ${(err as Error).message}`);
    return Response.json({ error: 'upstream request failed' }, { status: 502 });
  }

  if (!upstream.ok || !upstream.body) {
    console.error(`POST /api/qa/agentic → upstream ${upstream.status}`);
    return Response.json({ error: 'upstream request failed' }, { status: upstream.status || 502 });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  });
}
