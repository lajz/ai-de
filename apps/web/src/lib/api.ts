import type {
  ConnectorConfig,
  Engagement,
  EngagementGraph,
  Fact,
  FactProvenance,
  PipelineStatus,
  PutConnectorBody,
  QaResult,
  SyncMode,
} from './types';

const DEFAULT_BASE_URL = 'http://localhost:3000';

/** `@fde/api` base URL. Configurable so the web app can point at any deployment. */
export function apiBaseUrl(): string {
  return process.env.API_BASE_URL ?? DEFAULT_BASE_URL;
}

/** Where the "Sign in" link sends the browser — the API owns the WorkOS flow. */
export function loginUrl(): string {
  return `${apiBaseUrl()}/auth/login`;
}

/** A non-2xx response from `@fde/api`, carrying the upstream status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Server-side proxied call to `@fde/api`. The caller's session token (from the
 * `fde_session` cookie, or the documented dev fallback) is forwarded as a bearer
 * token; the API re-derives tenant/engagement scope + authz from it. Never
 * cached — every read must re-run the authz gate.
 */
async function apiJson<T>(
  path: string,
  token: string | undefined,
  init?: { method?: string; body?: string },
): Promise<T> {
  const res = await fetch(`${apiBaseUrl()}${path}`, {
    method: init?.method ?? 'GET',
    body: init?.body,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new ApiError(res.status, `${init?.method ?? 'GET'} ${path} → ${res.status}`);
  }
  return (await res.json()) as T;
}

export function getEngagements(token: string | undefined): Promise<Engagement[]> {
  return apiJson<Engagement[]>('/engagements', token);
}

export function getFacts(token: string | undefined, engagementId: string): Promise<Fact[]> {
  return apiJson<Fact[]>(`/engagements/${engagementId}/facts`, token);
}

export function askQuestion(
  token: string | undefined,
  engagementId: string,
  question: string,
): Promise<QaResult> {
  return apiJson<QaResult>(`/engagements/${engagementId}/qa`, token, {
    method: 'POST',
    body: JSON.stringify({ question }),
  });
}

// --- /admin: connector configuration -----------------------------------------

export function getConnectors(
  token: string | undefined,
  engagementId: string,
): Promise<ConnectorConfig[]> {
  return apiJson<ConnectorConfig[]>(`/engagements/${engagementId}/connectors`, token);
}

export function putConnector(
  token: string | undefined,
  engagementId: string,
  connectorId: string,
  body: PutConnectorBody,
): Promise<ConnectorConfig> {
  return apiJson<ConnectorConfig>(`/engagements/${engagementId}/connectors/${connectorId}`, token, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export function startConnectorSync(
  token: string | undefined,
  engagementId: string,
  connectorId: string,
  mode: SyncMode,
): Promise<{ workflowId: string }> {
  return apiJson<{ workflowId: string }>(
    `/engagements/${engagementId}/connectors/${connectorId}/sync`,
    token,
    { method: 'POST', body: JSON.stringify({ mode }) },
  );
}

// --- /admin: data lineage --------------------------------------------------

export function getFactProvenance(
  token: string | undefined,
  engagementId: string,
  factId: string,
): Promise<FactProvenance> {
  return apiJson<FactProvenance>(`/engagements/${engagementId}/facts/${factId}/provenance`, token);
}

export function getGraph(
  token: string | undefined,
  engagementId: string,
  filters?: { entityType?: string; predicate?: string },
): Promise<EngagementGraph> {
  const qs = new URLSearchParams();
  if (filters?.entityType) qs.set('entityType', filters.entityType);
  if (filters?.predicate) qs.set('predicate', filters.predicate);
  const suffix = qs.toString() ? `?${qs}` : '';
  return apiJson<EngagementGraph>(`/engagements/${engagementId}/graph${suffix}`, token);
}

export function getPipeline(
  token: string | undefined,
  engagementId: string,
  limit?: number,
): Promise<PipelineStatus> {
  const suffix = limit ? `?limit=${limit}` : '';
  return apiJson<PipelineStatus>(`/engagements/${engagementId}/pipeline${suffix}`, token);
}
