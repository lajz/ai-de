'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';

import { parseSseStream } from '../lib/sse';
import type { AgenticQaEvent, QaCitation, QaTurn } from '../lib/types';
import { safeHttpUrl } from '../lib/url';

interface ToolStep {
  tool: string;
  status: 'started' | 'ok' | 'error';
}

/** One rendered turn — `citations` only ever present on an `assistant` turn. */
interface RenderedTurn extends QaTurn {
  citations?: QaCitation[];
}

/**
 * One message bubble — pulled out of `AskPanel` as its own pure component
 * so it's unit-testable by itself (`renderToStaticMarkup` over a fixed
 * `RenderedTurn`) without needing to drive `AskPanel`'s full fetch/SSE flow.
 */
export function AskTurnBubble({
  turn,
  engagementId,
}: {
  turn: RenderedTurn;
  engagementId: string;
}) {
  if (turn.role === 'user') {
    return <div className="qa-bubble qa-bubble-user">{turn.content}</div>;
  }
  return (
    <div className="qa-bubble qa-bubble-assistant">
      <div className="markdown-content">
        <ReactMarkdown>{turn.content}</ReactMarkdown>
      </div>
      {turn.citations && turn.citations.length > 0 && (
        <ul className="citations">
          {turn.citations.map((c, j) => {
            const href = safeHttpUrl(c.permalink);
            return (
              <li key={j}>
                <q>{c.quote}</q>{' '}
                <Link href={`/engagements/${engagementId}/lineage?factId=${c.factId}`}>
                  provenance
                </Link>
                {href && (
                  <>
                    {' · '}
                    <a href={href} target="_blank" rel="noreferrer">
                      source
                    </a>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * Single-engagement Q&A box. POSTs to the same-origin `/api/qa/agentic` proxy
 * (which forwards the session cookie server-side to `@fde/api` and streams
 * its SSE body straight through), rendering each tool call live as it
 * happens, then the final answer + citations once the loop settles.
 *
 * A continuous conversation, not one-shot: `/qa/agentic` is stateless across
 * requests, so this component is what remembers it — `turns` accumulates
 * every question and answer, and each new question resends the whole
 * transcript so far as `history`. "New conversation" is the only way to
 * drop it and start over.
 *
 * Shaped like a standard chat UI: `.ask-messages` is the one scrolling
 * region (auto-scrolled to the latest turn), the composer stays pinned
 * below it, and the in-flight tool-steps render as a "thinking" bubble in
 * the assistant's own slot rather than a disconnected list under the
 * input. The assistant's answer is rendered as markdown for formatting
 * only — `react-markdown` never executes raw HTML (no `rehype-raw`), which
 * matters here specifically: the answer text ultimately derives from
 * ingested, untrusted source content via the extraction pipeline, so it
 * gets the same "data, never instructions, never raw HTML" treatment every
 * connector gives ingested content.
 */
export function AskPanel({ engagementId }: { engagementId: string }) {
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<RenderedTurn[]>([]);
  const [steps, setSteps] = useState<ToolStep[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, steps, pending, error]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const asked = question.trim();
    if (!asked) return;

    const history: QaTurn[] = turns.map(({ role, content }) => ({ role, content }));
    setPending(true);
    setError(null);
    setSteps([]);
    setQuestion('');
    setTurns((prev) => [...prev, { role: 'user', content: asked }]);

    try {
      const res = await fetch('/api/qa/agentic', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ engagementId, question: asked, history }),
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
          setTurns((prev) => [
            ...prev,
            { role: 'assistant', content: event.answer, citations: event.citations },
          ]);
        } else if (event.type === 'error') {
          setError(event.message);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'request failed');
    } finally {
      setPending(false);
      setSteps([]);
    }
  }

  function onNewConversation() {
    setTurns([]);
    setSteps([]);
    setError(null);
  }

  return (
    <section className="ask">
      <div className="ask-head">
        <h2>Ask</h2>
        {turns.length > 0 && (
          <button type="button" className="btn btn-quiet" onClick={onNewConversation}>
            New conversation
          </button>
        )}
      </div>

      <ul className="ask-messages" aria-label="conversation" ref={messagesRef}>
        {turns.length === 0 && !pending && (
          <li className="ask-empty">Ask a question about this engagement to get started.</li>
        )}
        {turns.map((t, i) => (
          <li key={i} className={`qa-turn qa-turn-${t.role}`}>
            <AskTurnBubble turn={t} engagementId={engagementId} />
          </li>
        ))}
        {pending && (
          <li className="qa-turn qa-turn-assistant">
            <div className="qa-bubble qa-bubble-assistant qa-bubble-pending">
              {steps.length === 0 ? (
                <span className="qa-thinking">Thinking…</span>
              ) : (
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
            </div>
          </li>
        )}
        {error && (
          <li className="qa-turn qa-turn-error">
            <p role="alert" className="qa-error">
              {error}
            </p>
          </li>
        )}
      </ul>

      <form className="ask-composer" onSubmit={onSubmit}>
        <input
          type="text"
          className="field-input"
          aria-label="question"
          placeholder={
            turns.length > 0 ? 'Ask a follow-up question' : 'Ask a question about this engagement'
          }
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
    </section>
  );
}
