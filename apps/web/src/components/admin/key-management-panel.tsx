'use client';

import { useState } from 'react';

import { submitByokKey } from '../../lib/admin-client';

export function KeyManagementPanel({
  engagementId,
  initialByokKeyArn,
}: {
  engagementId: string;
  initialByokKeyArn: string | null;
}) {
  const [byokKeyArn, setByokKeyArnState] = useState(initialByokKeyArn);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justRotated, setJustRotated] = useState(false);

  async function submit() {
    if (input.trim() === '') return;
    setPending(true);
    setError(null);
    setJustRotated(false);
    try {
      const res = await submitByokKey(engagementId, input.trim());
      setByokKeyArnState(res.byokKeyArn);
      setInput('');
      setJustRotated(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to set the BYOK key');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="key-management">
      <div className="key-management-status">
        <span>Encryption key:</span>
        {byokKeyArn ? (
          <>
            <span className="key-management-badge key-management-badge-byok">
              customer-managed (BYOK)
            </span>
            <span className="key-management-key-id" title={byokKeyArn}>
              {byokKeyArn}
            </span>
          </>
        ) : (
          <span className="key-management-badge">platform-managed tenant key</span>
        )}
      </div>

      <p className="key-management-help">
        Bringing your own key means this engagement&rsquo;s data-encryption key is wrapped by a KMS
        key in <strong>your</strong> AWS account instead of ours. Before submitting a key below,
        grant this platform&rsquo;s AWS principal <code>kms:Decrypt</code> and{' '}
        <code>kms:Encrypt</code> on it via a cross-account KMS grant, in your own AWS console.
        Submitting is itself the check: if the grant isn&rsquo;t set up yet, or hasn&rsquo;t
        propagated, the request below fails cleanly and this engagement keeps working under its
        current key. Revoking that grant later — entirely in your own AWS account — is what makes
        this engagement&rsquo;s content permanently unreadable, without us ever touching a button.
      </p>

      <form
        className="key-management-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="field-label">
          {byokKeyArn ? 'Rotate to a different KMS key ARN' : 'KMS key ARN'}
          <input
            type="text"
            className="field-input"
            aria-label="KMS key ARN"
            placeholder="arn:aws:kms:us-east-1:111122223333:key/1234abcd-..."
            value={input}
            disabled={pending}
            onChange={(e) => setInput(e.target.value)}
          />
        </label>
        <button type="submit" className="btn btn-primary" disabled={pending || input.trim() === ''}>
          {byokKeyArn ? 'Rotate key' : 'Set customer-managed key'}
        </button>
      </form>

      {error && (
        <p className="key-management-error" role="alert">
          {error}
        </p>
      )}
      {justRotated && !error && (
        <p className="key-management-success" role="status">
          This engagement now decrypts through the customer-managed key above.
        </p>
      )}
    </div>
  );
}
