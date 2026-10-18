import type {
  ConnectorConfig,
  CryptoShredResult,
  CustomIntegration,
  CustomIntegrationMapping,
  CustomIntegrationWithSecret,
  CustomMappingTestResult,
  UpdateCustomIntegrationBody,
  PutConnectorBody,
  SetByokKeyResult,
  SyncMode,
} from './types';

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as {
    error?: string;
    issues?: { at: string; message: string }[];
  } | null;
  const base = body?.error ?? `request failed (${res.status})`;
  // surface per-field mapping issues (422) inline — they are what the admin must fix
  return body?.issues?.length
    ? `${base}: ${body.issues.map((i) => `${i.at}: ${i.message}`).join('; ')}`
    : base;
}

async function jsonCall<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(await readError(res));
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

/** Browser → same-origin proxy → `PUT /engagements/:id/connectors/:connectorId`. */
export async function saveConnector(
  engagementId: string,
  connectorId: string,
  patch: PutConnectorBody,
): Promise<ConnectorConfig> {
  const res = await fetch('/api/admin/connectors', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ engagementId, connectorId, ...patch }),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as ConnectorConfig;
}

/** Browser → same-origin proxy → `POST /engagements/:id/connectors/:connectorId/sync`. */
export async function triggerSync(
  engagementId: string,
  connectorId: string,
  mode: SyncMode,
): Promise<{ workflowId: string }> {
  const res = await fetch('/api/admin/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ engagementId, connectorId, mode }),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as { workflowId: string };
}

/** Browser → same-origin proxy → `POST /engagements/:id/crypto-shred`. Irreversible. */
export async function triggerCryptoShred(
  engagementId: string,
  reason: string,
): Promise<CryptoShredResult> {
  const res = await fetch('/api/admin/crypto-shred', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ engagementId, reason }),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as CryptoShredResult;
}

/** Browser → same-origin proxy → `POST /engagements/:id/crypto/byok-key`. Sets or rotates BYOK/CMEK. */
export async function submitByokKey(
  engagementId: string,
  byokKeyArn: string,
): Promise<SetByokKeyResult> {
  const res = await fetch('/api/admin/byok-key', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ engagementId, byokKeyArn }),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as SetByokKeyResult;
}

// --- Custom integrations (same-origin proxies under /api/admin/integrations) ---

export function createCustomIntegration(
  engagementId: string,
  name: string,
  mapping: CustomIntegrationMapping,
): Promise<CustomIntegrationWithSecret> {
  return jsonCall('/api/admin/integrations', 'POST', { engagementId, name, mapping });
}

export function updateCustomIntegration(
  engagementId: string,
  integrationId: string,
  patch: UpdateCustomIntegrationBody,
): Promise<CustomIntegration> {
  return jsonCall(`/api/admin/integrations/${integrationId}`, 'PUT', { engagementId, ...patch });
}

export function deleteCustomIntegration(
  engagementId: string,
  integrationId: string,
): Promise<void> {
  return jsonCall(
    `/api/admin/integrations/${integrationId}?engagementId=${encodeURIComponent(engagementId)}`,
    'DELETE',
  );
}

export function rotateCustomIntegrationSecret(
  engagementId: string,
  integrationId: string,
): Promise<CustomIntegrationWithSecret> {
  return jsonCall(`/api/admin/integrations/${integrationId}/rotate-secret`, 'POST', {
    engagementId,
  });
}

export function testCustomIntegrationMapping(
  engagementId: string,
  mapping: CustomIntegrationMapping,
  payload: unknown,
): Promise<CustomMappingTestResult> {
  return jsonCall('/api/admin/integrations/test', 'POST', { engagementId, mapping, payload });
}
