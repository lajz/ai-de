import type { ConnectorConfig, PutConnectorBody, SyncMode } from './types';

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `request failed (${res.status})`;
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
