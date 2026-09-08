import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AskPanel } from './components/ask-panel';
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
    const html = renderToStaticMarkup(<FactList facts={facts} />);
    expect(html).toContain('decision');
    expect(html).toContain('The team will standardize on Postgres.');
    expect(html).toContain('Chosen over DynamoDB');
    expect(html).toContain('href="https://ex.com/transcript/1"');
    expect(html).toContain('we will standardize on Postgres');
  });

  it('renders an empty state when there are no facts', () => {
    expect(renderToStaticMarkup(<FactList facts={[]} />)).toContain('No facts extracted');
  });
});

describe('AskPanel', () => {
  it('renders the question form for an engagement', () => {
    const html = renderToStaticMarkup(<AskPanel engagementId="eng-1" />);
    expect(html).toContain('aria-label="question"');
    expect(html).toContain('Ask</button>');
  });
});
