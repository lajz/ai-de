import { NextResponse } from 'next/server';

import { createCustomIntegration } from '../../../../lib/api';
import { getSessionToken } from '../../../../lib/session';
import type { CustomIntegrationMapping } from '../../../../lib/types';
import { proxyError, readBody, requireString } from './_proxy';

/** Same-origin proxy for `POST /engagements/:id/integrations`. The one-time `secret` rides this response only. */
export async function POST(req: Request): Promise<NextResponse> {
  const body = await readBody(req);
  if (body instanceof NextResponse) return body;
  const engagementId = requireString(body.engagementId, 'engagementId');
  if (engagementId instanceof NextResponse) return engagementId;
  const name = requireString(body.name, 'name');
  if (name instanceof NextResponse) return name;

  const token = await getSessionToken();
  try {
    return NextResponse.json(
      await createCustomIntegration(token, engagementId, {
        name,
        mapping: body.mapping as CustomIntegrationMapping,
      }),
    );
  } catch (err) {
    return proxyError('POST /api/admin/integrations', err);
  }
}
