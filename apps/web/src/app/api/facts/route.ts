import { NextResponse } from 'next/server';

import { ApiError, getFacts } from '../../../lib/api';
import { getSessionToken } from '../../../lib/session';

/**
 * Same-origin proxy for `GET /engagements/:id/facts`. `FactList` /
 * `LineagePicker`'s "Load more" is a client component (it holds page state),
 * so it can't call `@fde/api` directly with the session cookie the way server
 * components do — it hits this route instead, which forwards the caller's
 * session token server-side. Mirrors `/api/admin/entity-provenance`'s proxy
 * shape: GET + query string, pure read.
 */
export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const engagementId = url.searchParams.get('engagementId');
  if (!engagementId) {
    return NextResponse.json({ error: 'engagementId is required' }, { status: 400 });
  }
  const cursor = url.searchParams.get('cursor') ?? undefined;
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? Number(limitParam) : undefined;
  if (limit !== undefined && !Number.isFinite(limit)) {
    return NextResponse.json({ error: 'limit must be a number' }, { status: 400 });
  }

  const token = await getSessionToken();
  try {
    return NextResponse.json(await getFacts(token, engagementId, { limit, cursor }));
  } catch (err) {
    const status = err instanceof ApiError ? err.status : 502;
    console.error(`GET /api/facts → upstream ${status}: ${(err as Error).message}`);
    return NextResponse.json({ error: 'upstream request failed' }, { status });
  }
}
