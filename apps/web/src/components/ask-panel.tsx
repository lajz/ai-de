'use client';

import { useState } from 'react';

import type { QaResult } from '../lib/types';
import { safeHttpUrl } from '../lib/url';

/**
 * Single-engagement Q&A box. POSTs to the same-origin `/api/qa` proxy (which
 * forwards the session cookie server-side to `@fde/api`), then renders the
 * answer and its citation links.
 */
export function AskPanel({ engagementId }: { engagementId: string }) {
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState<QaResult | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/qa', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ engagementId, question }),
      });
      if (!res.ok) throw new Error(`request failed (${res.status})`);
      setResult((await res.json()) as QaResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'request failed');
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="ask">
      <h2>Ask</h2>
      <form onSubmit={onSubmit}>
        <input
          type="text"
          className="field-input"
          aria-label="question"
          placeholder="Ask a question about this engagement"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <button
          type="submit"
          className="btn btn-primary"
          disabled={pending || question.trim() === ''}
        >
          {pending ? 'Asking…' : 'Ask'}
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      {result && (
        <div className="answer">
          <p>{result.answer}</p>
          {result.citations.length > 0 && (
            <ul className="citations">
              {result.citations.map((c, i) => {
                const href = safeHttpUrl(c.permalink);
                return (
                  <li key={i}>
                    {c.quote}{' '}
                    {href && (
                      <a href={href} target="_blank" rel="noreferrer">
                        source
                      </a>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
