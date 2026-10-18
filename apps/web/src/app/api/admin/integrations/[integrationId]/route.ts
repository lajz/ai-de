import { NextResponse } from 'next/server';

import { deleteCustomIntegration, updateCustomIntegration } from '../../../../../lib/api';
import { getSessionToken } from '../../../../../lib/session';
import type { UpdateCustomIntegrationBody } from '../../../../../lib/types';
import { proxyError, readBody, requireString } from '../_proxy';

type Ctx = { params: Promise<{ integrationId: string }> };

/** Same-origin proxy for `PUT /engagements/:id/integrations/:integrationId`. */
export async function PUT(req: Request, { params }: Ctx): Promise<NextResponse> {
  const { integrationId } = await params;
  const body = await readBody(req);
  if (body instanceof NextResponse) return body;
  const engagementId = requireString(body.engagementId, 'engagementId');
  if (engagementId instanceof NextResponse) return engagementId;

  const patch = { ...body };
  delete patch.engagementId;
  const token = await getSessionToken();
  try {
    return NextResponse.json(
      await updateCustomIntegration(
        token,
        engagementId,
        integrationId,
        patch as UpdateCustomIntegrationBody,
      ),
    );
  } catch (err) {
    return proxyError('PUT /api/admin/integrations/:id', err);
  }
}

/** Same-origin proxy for `DELETE …/integrations/:integrationId` (`?engagementId=`). */
export async function DELETE(req: Request, { params }: Ctx): Promise<NextResponse> {
  const { integrationId } = await params;
  const engagementId = requireString(
    new URL(req.url).searchParams.get('engagementId'),
    'engagementId',
  );
  if (engagementId instanceof NextResponse) return engagementId;

  const token = await getSessionToken();
  try {
    await deleteCustomIntegration(token, engagementId, integrationId);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return proxyError('DELETE /api/admin/integrations/:id', err);
  }
}
