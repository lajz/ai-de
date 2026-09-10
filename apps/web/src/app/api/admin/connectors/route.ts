import { NextResponse } from 'next/server';

import { ApiError, putConnector } from '../../../../lib/api';
import { getSessionToken } from '../../../../lib/session';
import type { PutConnectorBody, RetentionPolicy } from '../../../../lib/types';

const RETENTION_POLICIES: RetentionPolicy[] = [
  'reference-only',
  'derived-ephemeral-raw',
  'full-retention',
];

/**
 * Same-origin proxy for `PUT /engagements/:id/connectors/:connectorId`. The
 * browser posts `{ engagementId, connectorId, ...patch }`; this handler forwards
 * the patch to `@fde/api` with the caller's session token. The `credential` only
 * ever travels request → API, never back.
 */
export async function PUT(req: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const { engagementId, connectorId, enabled, retentionOverride, credential } = (body ?? {}) as {
    engagementId?: unknown;
    connectorId?: unknown;
    enabled?: unknown;
    retentionOverride?: unknown;
    credential?: unknown;
  };
  if (typeof engagementId !== 'string' || engagementId === '') {
    return NextResponse.json({ error: 'engagementId is required' }, { status: 400 });
  }
  if (typeof connectorId !== 'string' || connectorId === '') {
    return NextResponse.json({ error: 'connectorId is required' }, { status: 400 });
  }

  const patch: PutConnectorBody = {};
  if (enabled !== undefined) {
    if (typeof enabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 });
    }
    patch.enabled = enabled;
  }
  if ('retentionOverride' in (body as object)) {
    if (
      retentionOverride !== null &&
      !RETENTION_POLICIES.includes(retentionOverride as RetentionPolicy)
    ) {
      return NextResponse.json({ error: 'invalid retentionOverride' }, { status: 400 });
    }
    patch.retentionOverride = retentionOverride as RetentionPolicy | null;
  }
  if (credential !== undefined) {
    if (typeof credential !== 'string' || credential.trim() === '') {
      return NextResponse.json({ error: 'credential must be a non-empty string' }, { status: 400 });
    }
    patch.credential = credential;
  }

  const token = await getSessionToken();
  try {
    return NextResponse.json(await putConnector(token, engagementId, connectorId, patch));
  } catch (err) {
    const status = err instanceof ApiError ? err.status : 502;
    console.error(`PUT /api/admin/connectors → upstream ${status}: ${(err as Error).message}`);
    return NextResponse.json({ error: 'upstream request failed' }, { status });
  }
}
