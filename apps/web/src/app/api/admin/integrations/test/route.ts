import { NextResponse } from 'next/server';

import { testCustomIntegrationMapping } from '../../../../../lib/api';
import { getSessionToken } from '../../../../../lib/session';
import type { CustomIntegrationMapping } from '../../../../../lib/types';
import { proxyError, readBody, requireString } from '../_proxy';

/** Same-origin proxy for the pure dry-run `POST /engagements/:id/integrations/test`. */
export async function POST(req: Request): Promise<NextResponse> {
  const body = await readBody(req);
  if (body instanceof NextResponse) return body;
  const engagementId = requireString(body.engagementId, 'engagementId');
  if (engagementId instanceof NextResponse) return engagementId;

  const token = await getSessionToken();
  try {
    return NextResponse.json(
      await testCustomIntegrationMapping(token, engagementId, {
        mapping: body.mapping as CustomIntegrationMapping,
        payload: body.payload,
      }),
    );
  } catch (err) {
    return proxyError('POST /api/admin/integrations/test', err);
  }
}
