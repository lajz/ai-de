'use client';

import { useState } from 'react';

import { triggerCryptoShred } from '../../lib/admin-client';
import type { CryptoShredResult } from '../../lib/types';

/** The confirm-gate: only a reason plus the engagement's own name, typed exactly, unlocks the button. */
export function shredConfirmed(
  endCustomerName: string,
  typedName: string,
  reason: string,
): boolean {
  return typedName === endCustomerName && reason.trim() !== '';
}

export function DangerZone({
  engagementId,
  endCustomerName,
  initialStatus,
}: {
  engagementId: string;
  endCustomerName: string;
  initialStatus: string;
}) {
  const [status, setStatus] = useState(initialStatus);
  const [typedName, setTypedName] = useState('');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CryptoShredResult | null>(null);

  if (status === 'shredded' || result) {
    return (
      <div className="danger-zone-shredded" role="status">
        <p className="danger-zone-shredded-title">This engagement has been crypto-shredded.</p>
        <p className="danger-zone-shredded-body">
          Its data-encryption key has been destroyed. Every encrypted field for this engagement
          (transcripts, facts, evidence quotes, connector credentials) is now permanently unreadable
          — this cannot be undone. A background job is purging the now-dead ciphertext from storage;
          that step is cleanup only and does not affect the security guarantee above, which already
          holds.
        </p>
      </div>
    );
  }

  const confirmed = shredConfirmed(endCustomerName, typedName, reason);

  async function submit() {
    if (!confirmed) return;
    setPending(true);
    setError(null);
    try {
      const res = await triggerCryptoShred(engagementId, reason);
      setResult(res);
      setStatus('shredded');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'crypto-shred failed');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="danger-zone">
      <p className="danger-zone-status">
        Current status: <span className={`status-pill status-pill-${status}`}>{status}</span>
      </p>
      <p className="danger-zone-warning">
        Crypto-shredding destroys this engagement&rsquo;s data-encryption key. Every encrypted field
        becomes permanently unreadable, immediately — there is no undo, and no support process that
        can recover it afterward.
      </p>
      <form
        className="danger-zone-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="field-label">
          Reason
          <input
            type="text"
            className="field-input"
            aria-label="reason for crypto-shredding this engagement"
            placeholder="e.g. customer offboarded"
            value={reason}
            disabled={pending}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <label className="field-label">
          Type <strong>{endCustomerName}</strong> to confirm
          <input
            type="text"
            className="field-input"
            aria-label="type the engagement name to confirm"
            value={typedName}
            disabled={pending}
            onChange={(e) => setTypedName(e.target.value)}
          />
        </label>
        <button type="submit" className="btn btn-danger" disabled={pending || !confirmed}>
          Crypto-shred this engagement
        </button>
      </form>
      {error && (
        <p className="danger-zone-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
