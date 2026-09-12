'use client';

import { useState } from 'react';

import { saveConnector, triggerSync } from '../../lib/admin-client';
import { relativeTime } from '../../lib/relative-time';
import type { ConnectorConfig, RetentionPolicy, SyncMode } from '../../lib/types';

const RETENTION_OPTIONS: { value: RetentionPolicy | 'inherit'; label: string }[] = [
  { value: 'inherit', label: 'Inherit engagement policy' },
  { value: 'reference-only', label: 'reference-only' },
  { value: 'derived-ephemeral-raw', label: 'derived-ephemeral-raw' },
  { value: 'full-retention', label: 'full-retention' },
];

export function ConnectorCard({
  engagementId,
  connector: initial,
}: {
  engagementId: string;
  connector: ConnectorConfig;
}) {
  const [connector, setConnector] = useState(initial);
  const [credential, setCredential] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function save(patch: Parameters<typeof saveConnector>[2]) {
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      setConnector(await saveConnector(engagementId, connector.connector, patch));
      if (patch.credential !== undefined) setCredential('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save failed');
    } finally {
      setPending(false);
    }
  }

  async function sync(mode: SyncMode) {
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const { workflowId } = await triggerSync(engagementId, connector.connector, mode);
      setNotice(`${mode} started (${workflowId})`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'sync failed');
    } finally {
      setPending(false);
    }
  }

  const { sync: syncState } = connector;
  const lastRun = relativeTime(syncState.lastRunAt);

  return (
    <li className="connector-card">
      <div className="connector-head">
        <span className="connector-name">{connector.connector}</span>
        <span className="connector-authkind">{connector.authKind}</span>
        <label className="connector-toggle">
          <input
            type="checkbox"
            checked={connector.enabled}
            disabled={pending}
            onChange={(e) => save({ enabled: e.target.checked })}
          />
          enabled
        </label>
      </div>

      <div className="connector-row">
        <label className="field-label">
          Retention override
          <select
            className="field-input"
            value={connector.effectiveRetention}
            disabled={pending}
            onChange={(e) =>
              save({
                retentionOverride:
                  e.target.value === 'inherit' ? null : (e.target.value as RetentionPolicy),
              })
            }
          >
            {RETENTION_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <span className="connector-retention-effective">
          effective: {connector.effectiveRetention}
        </span>
      </div>

      <form
        className="connector-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (credential.trim()) save({ credential });
        }}
      >
        <label className="field-label">
          Credential
          <input
            type="password"
            className="field-input"
            aria-label={`${connector.connector} credential`}
            placeholder={connector.hasCredential ? '•••• set — enter to replace' : 'not set'}
            value={credential}
            disabled={pending}
            onChange={(e) => setCredential(e.target.value)}
          />
        </label>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={pending || credential.trim() === ''}
        >
          Save credential
        </button>
      </form>

      <div className="connector-row">
        <button type="button" className="btn" disabled={pending} onClick={() => sync('backfill')}>
          Backfill
        </button>
        <button
          type="button"
          className="btn"
          disabled={pending}
          onClick={() => sync('incremental')}
        >
          Incremental
        </button>
        <span className="sync-badge">
          <span
            className={`status-dot status-dot-${syncState.status ?? 'none'}`}
            aria-hidden="true"
          />
          {syncState.status ?? 'never run'}
          {lastRun && <span className="sync-meta">{lastRun}</span>}
          {syncState.cursorPresent && <span className="sync-meta">cursor set</span>}
        </span>
      </div>

      {error && (
        <p className="connector-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="connector-notice">{notice}</p>}
    </li>
  );
}
