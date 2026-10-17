import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AskPanel, AskTurnBubble } from './components/ask-panel';
import { FactList } from './components/fact-list';
import type { Fact } from './lib/types';

const facts: Fact[] = [
  {
    id: 'f1',
    type: 'decision',
    summary: 'The team will standardize on Postgres.',
    body: 'Chosen over DynamoDB for relational querying.',
    status: 'open',
    confidence: 0.9,
    occurredAt: null,
    createdAt: '2026-02-02T00:00:00Z',
    citations: [
      {
        sourceId: 's1',
        permalink: 'https://ex.com/transcript/1',
        quote: 'we will standardize on Postgres',
        charStart: 0,
        charEnd: 10,
        relation: 'supports',
      },
    ],
  },
];

describe('FactList', () => {
  it('renders each fact with its type, summary, body and a citation permalink', () => {
    const html = renderToStaticMarkup(<FactList engagementId="eng-1" initialFacts={facts} />);
    expect(html).toContain('decision');
    expect(html).toContain('The team will standardize on Postgres.');
    expect(html).toContain('Chosen over DynamoDB');
    expect(html).toContain('href="https://ex.com/transcript/1"');
    expect(html).toContain('we will standardize on Postgres');
  });

  it('links each fact to its full provenance chain', () => {
    const html = renderToStaticMarkup(<FactList engagementId="eng-1" initialFacts={facts} />);
    expect(html).toContain('href="/engagements/eng-1/lineage?factId=f1"');
  });

  it('renders an empty state when there are no facts', () => {
    expect(renderToStaticMarkup(<FactList engagementId="eng-1" initialFacts={[]} />)).toContain(
      'No facts extracted',
    );
  });

  it('renders a "Load more" button only when a next cursor is present', () => {
    const withMore = renderToStaticMarkup(
      <FactList engagementId="eng-1" initialFacts={facts} initialCursor="c1" />,
    );
    expect(withMore).toContain('Load more');

    const withoutMore = renderToStaticMarkup(
      <FactList engagementId="eng-1" initialFacts={facts} />,
    );
    expect(withoutMore).not.toContain('Load more');
  });
});

describe('AskPanel', () => {
  it('renders the question form for an engagement', () => {
    const html = renderToStaticMarkup(<AskPanel engagementId="eng-1" />);
    expect(html).toContain('aria-label="question"');
    expect(html).toContain('Ask</button>');
  });
});

describe('AskTurnBubble', () => {
  it('renders a user turn as a plain-text bubble, not markdown', () => {
    const html = renderToStaticMarkup(
      <AskTurnBubble engagementId="eng-1" turn={{ role: 'user', content: '**not bold**' }} />,
    );
    expect(html).toContain('qa-bubble-user');
    expect(html).toContain('**not bold**'); // literal, not parsed as markdown
    expect(html).not.toContain('<strong>');
  });

  it('renders an assistant turn as markdown inside a distinct bubble', () => {
    const html = renderToStaticMarkup(
      <AskTurnBubble
        engagementId="eng-1"
        turn={{ role: 'assistant', content: 'We chose **Postgres** for the system of record.' }}
      />,
    );
    expect(html).toContain('qa-bubble-assistant');
    expect(html).toContain('<strong>Postgres</strong>');
  });

  it('links a citation to both its Lineage provenance chain and its external permalink', () => {
    const html = renderToStaticMarkup(
      <AskTurnBubble
        engagementId="eng-1"
        turn={{
          role: 'assistant',
          content: 'Postgres was chosen.',
          citations: [
            {
              sourceId: 's1',
              permalink: 'https://ex.com/transcript/1',
              quote: 'we will standardize on Postgres',
              factId: 'f1',
            },
          ],
        }}
      />,
    );
    expect(html).toContain('href="/engagements/eng-1/lineage?factId=f1"');
    expect(html).toContain('href="https://ex.com/transcript/1"');
    expect(html).toContain('we will standardize on Postgres');
  });

  it('renders no citations list when the answer has none', () => {
    const html = renderToStaticMarkup(
      <AskTurnBubble engagementId="eng-1" turn={{ role: 'assistant', content: 'No sources.' }} />,
    );
    expect(html).not.toContain('citations');
  });
});
