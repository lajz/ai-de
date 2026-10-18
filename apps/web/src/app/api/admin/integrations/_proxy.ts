import { NextResponse } from 'next/server';

import { ApiError } from '../../../../lib/api';

/**
 * Shared error mapping for the custom-integration proxies. A 422 carries the
 * API's per-field mapping `issues` — safe and necessary to relay (the caller is
 * the admin who just submitted the mapping). Other upstream detail is not echoed.
 */
export function proxyError(label: string, err: unknown): NextResponse {
  const status = err instanceof ApiError ? err.status : 502;
  console.error(`${label} → upstream ${status}: ${(err as Error).message}`);
  if (status === 422 && err instanceof ApiError) {
    return NextResponse.json({ error: err.message, issues: err.issues ?? [] }, { status });
  }
  const messages: Record<number, string> = {
    400: 'invalid request',
    403: 'not authorized to administer this engagement',
    404: 'integration not found',
  };
  return NextResponse.json({ error: messages[status] ?? 'upstream request failed' }, { status });
}

export async function readBody(req: Request): Promise<Record<string, unknown> | NextResponse> {
  try {
    const body: unknown = await req.json();
    if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
  } catch {
    /* fallthrough */
  }
  return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
}

export function requireString(v: unknown, name: string): string | NextResponse {
  return typeof v === 'string' && v !== ''
    ? v
    : NextResponse.json({ error: `${name} is required` }, { status: 400 });
}
