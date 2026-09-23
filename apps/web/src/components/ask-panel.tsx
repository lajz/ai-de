'use client';

import { useState } from 'react';

import { parseSseStream } from '../lib/sse';
import type { AgenticQaEvent, QaCitation } from '../lib/types';
import { safeHttpUrl } from '../lib/url';

interface ToolStep {
  tool: string;
  status: 'started' | 'ok' | 'error';
}

/**
 * Single-engagement Q&A box. POSTs to the same-origin `/api/qa/agentic` proxy
 * (which forwards the session cookie server-side to `@fde/api` and streams
 * its SSE body straight through), rendering each tool call live as it
 * happens, then the final answer + citations once the loop settles.
 */
export function AskPanel({ engagementId }: { engagementId: string }) {
  const [question, setQuestion] = useState('');
  const [steps, setSteps] = useState<ToolStep[]>([]);
  const [answer, setAnswer] = useState<{ answer: string; citations: QaCitation[] } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    setSteps([]);
    setAnswer(null);
    try {
      const res = await fetch('/api/qa/agentic', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ engagementId, question }),
      });
      if (!res.ok || !res.body) throw new Error(`request failed (${res.status})`);

      for await (const raw of parseSseStream(res.body)) {
        const event = JSON.parse(raw) as AgenticQaEvent;
        if (event.type === 'tool_step') {
          setSteps((prev) =>
            event.status === 'started'
              ? [...prev, { tool: event.tool, status: 'started' }]
              : prev.map((s, i) =>
                  i === prev.length - 1 && s.tool === event.tool
                    ? { ...s, status: event.status }
                    : s,
                ),
          );
        } else if (event.type === 'answer') {
          setAnswer({ answer: event.answer, citations: event.citations });
        } else if (event.type === 'error') {
          setError(event.message);
        }
      }
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
      {steps.length > 0 && (
        <ul className="tool-steps" aria-label="tool steps">
          {steps.map((s, i) => (
            <li key={i}>
              {s.status === 'started' && `Checking ${s.tool}…`}
              {s.status === 'ok' && `Checked ${s.tool}`}
              {s.status === 'error' && `${s.tool} failed`}
            </li>
          ))}
        </ul>
      )}
      {error && <p role="alert">{error}</p>}
      {answer && (
        <div className="answer">
          <p>{answer.answer}</p>
          {answer.citations.length > 0 && (
            <ul className="citations">
              {answer.citations.map((c, i) => {
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
