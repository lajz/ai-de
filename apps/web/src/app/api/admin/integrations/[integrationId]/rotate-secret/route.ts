import { NextResponse } from 'next/server';

import { rotateCustomIntegrationSecret } from '../../../../../../lib/api';
import { getSessionToken } from '../../../../../../lib/session';
import { proxyError, readBody, requireString } from '../../_proxy';

/** Same-origin proxy for `POST …/integrations/:integrationId/rotate-secret`. Returns the new secret once. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ integrationId: string }> },
): Promise<NextResponse> {
  const { integrationId } = await params;
  const body = await readBody(req);
  if (body instanceof NextResponse) return body;
  const engagementId = requireString(body.engagementId, 'engagementId');
  if (engagementId instanceof NextResponse) return engagementId;

  const token = await getSessionToken();
  try {
    return NextResponse.json(
      await rotateCustomIntegrationSecret(token, engagementId, integrationId),
    );
  } catch (err) {
    return proxyError('POST /api/admin/integrations/:id/rotate-secret', err);
  }
}
