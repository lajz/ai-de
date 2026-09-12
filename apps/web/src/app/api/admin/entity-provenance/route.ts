import { NextResponse } from 'next/server';

import { ApiError, getEntityProvenance } from '../../../../lib/api';
import { getSessionToken } from '../../../../lib/session';

/**
 * Same-origin proxy for `GET /engagements/:id/entities/:entityId/provenance`.
 * The entity graph panel is a client component (node selection is
 * interactive), so it can't call `@fde/api` directly with the session cookie
 * the way server components do — it hits this route instead, which forwards
 * the caller's session token server-side. Mirrors `/api/qa`'s proxy shape,
 * GET + query string instead of POST + body since this is a pure read.
 */
export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const engagementId = url.searchParams.get('engagementId');
  const entityId = url.searchParams.get('entityId');
  if (!engagementId) {
    return NextResponse.json({ error: 'engagementId is required' }, { status: 400 });
  }
  if (!entityId) {
    return NextResponse.json({ error: 'entityId is required' }, { status: 400 });
  }

  const token = await getSessionToken();
  try {
    return NextResponse.json(await getEntityProvenance(token, engagementId, entityId));
  } catch (err) {
    const status = err instanceof ApiError ? err.status : 502;
    console.error(
      `GET /api/admin/entity-provenance → upstream ${status}: ${(err as Error).message}`,
    );
    return NextResponse.json({ error: 'upstream request failed' }, { status });
  }
}
