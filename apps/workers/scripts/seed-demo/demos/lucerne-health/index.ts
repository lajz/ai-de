import type { DemoDefinition } from '../../lib/types.js';
import {
  DEMO_GITHUB_PULL_REQUESTS,
  DEMO_GITHUB_REPOSITORY,
  DEMO_GRANOLA_BODIES,
  DEMO_GRANOLA_DOCUMENTS,
  DEMO_GRANOLA_TRANSCRIPTS,
  DEMO_GRANOLA_WORKSPACE,
  DEMO_LINEAR_ISSUES,
  DEMO_LINEAR_WORKSPACE,
} from './fixtures.js';

/**
 * Fathom Partners × Lucerne Health — "Project Harbor": an eligibility-check
 * API + claims reconciliation modernization ahead of Q4 open enrollment.
 * 5 Granola meetings, 7 Linear tickets, 3 GitHub pull requests, ~3 weeks. See
 * the fixtures in this folder for the full storyline; this file is only the
 * `DemoDefinition` wiring `orchestrate.ts` consumes.
 */
export const lucerneHealth: DemoDefinition = {
  slug: 'lucerne-health',
  endCustomerName: 'Lucerne Health — Project Harbor',
  granola: {
    workspace: DEMO_GRANOLA_WORKSPACE,
    documents: DEMO_GRANOLA_DOCUMENTS,
    transcripts: DEMO_GRANOLA_TRANSCRIPTS,
    bodies: DEMO_GRANOLA_BODIES,
  },
  linear: {
    workspace: DEMO_LINEAR_WORKSPACE,
    issues: DEMO_LINEAR_ISSUES,
    decisionMarker: {
      issueId: 'demo-harbor-1',
      sourceDocExternalId: 'demo-doc-week2',
      factType: 'decision',
    },
  },
  github: {
    repository: DEMO_GITHUB_REPOSITORY,
    pullRequests: DEMO_GITHUB_PULL_REQUESTS,
    decisionMarkers: [
      // Same source + type as `linear.decisionMarker` above — resolves to
      // the identical fact, so the graph shows the Week 2 rollout decision
      // fanning out into both the Linear ticket that tracks it (HARBOR-1)
      // and the PR that actually shipped it (#41).
      {
        pullRequestId: 'demo-harbor-pr-1',
        sourceDocExternalId: 'demo-doc-week2',
        factType: 'decision',
      },
    ],
  },
  qaQuestions: [
    {
      question: 'What did the team decide about the eligibility-check API rollout?',
      expectDocId: 'demo-doc-week2',
    },
    {
      question: 'Is the reconciliation SLA risk still open?',
      expectDocId: 'demo-doc-week3',
    },
    {
      question: 'Who raised the SOC 2 compliance question and when?',
      expectDocId: 'demo-doc-kickoff',
    },
    {
      question: 'What did Lucerne Health commit to for the go/no-go review?',
      expectDocId: 'demo-doc-week4',
    },
    {
      question: "What's the budget for Project Harbor?",
      expectNoAnswer: true,
    },
  ],
};
