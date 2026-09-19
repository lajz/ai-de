import type {
  GranolaDocument,
  GranolaParticipant,
  GranolaTranscript,
  GranolaWorkspace,
  LinearIssue,
  LinearUser,
  LinearWorkspace,
} from '@fde/connectors';

/**
 * Fixture data for the "lucerne-health" demo only. Never imported by any other
 * demo folder, and never touches `@fde/connectors`' own `FAKE_DOCUMENTS` /
 * `FAKE_LINEAR_ISSUES` — those stay exactly as they are for the connector unit
 * tests. See `index.ts` in this folder for the narrative wiring
 * (`DemoDefinition`) built from these arrays.
 */

// --- people --------------------------------------------------------------
// Same person, same email, on both sides — so `@fde/identity`'s email-tier
// match merges the Granola and Linear refs into one entity per person, for
// free, once both connectors sync.

const JORDAN: GranolaParticipant = {
  id: 'p-jordan',
  name: 'Jordan Ames',
  email: 'jordan@fathompartners.example',
};
const SAM: GranolaParticipant = {
  id: 'p-sam',
  name: 'Sam Whitfield',
  email: 'sam@fathompartners.example',
};
const MAYA: GranolaParticipant = {
  id: 'p-maya',
  name: 'Maya Okafor',
  email: 'maya@lucernehealth.example',
};
const DEREK: GranolaParticipant = {
  id: 'p-derek',
  name: 'Derek Lindqvist',
  email: 'derek@lucernehealth.example',
};
const PRIYA: GranolaParticipant = {
  id: 'p-priya',
  name: 'Priya Natarajan',
  email: 'priya@lucernehealth.example',
};
const NINA: GranolaParticipant = {
  id: 'p-nina',
  name: 'Nina Torres',
  email: 'nina@lucernehealth.example',
};

const LU_JORDAN: LinearUser = {
  id: 'lu-jordan',
  name: 'Jordan Ames',
  email: 'jordan@fathompartners.example',
};
const LU_SAM: LinearUser = {
  id: 'lu-sam',
  name: 'Sam Whitfield',
  email: 'sam@fathompartners.example',
};
const LU_MAYA: LinearUser = {
  id: 'lu-maya',
  name: 'Maya Okafor',
  email: 'maya@lucernehealth.example',
};
const LU_DEREK: LinearUser = {
  id: 'lu-derek',
  name: 'Derek Lindqvist',
  email: 'derek@lucernehealth.example',
};
const LU_PRIYA: LinearUser = {
  id: 'lu-priya',
  name: 'Priya Natarajan',
  email: 'priya@lucernehealth.example',
};

// --- Granola ---------------------------------------------------------------

export const DEMO_GRANOLA_WORKSPACE: GranolaWorkspace = {
  id: 'ws-lucerne-harbor',
  name: 'Lucerne Health × Fathom — Project Harbor',
  memberIds: [JORDAN.id, SAM.id, MAYA.id, DEREK.id, PRIYA.id, NINA.id],
};

export const DEMO_GRANOLA_DOCUMENTS: GranolaDocument[] = [
  {
    id: 'demo-doc-kickoff',
    workspaceId: DEMO_GRANOLA_WORKSPACE.id,
    title: 'Lucerne Health × Fathom — Project Harbor kickoff',
    createdAt: '2026-09-02T15:00:00.000Z',
    updatedAt: '2026-09-02T16:00:00.000Z',
    hasTranscript: true,
    participants: [MAYA, PRIYA, JORDAN],
    url: 'https://granola.ai/d/demo-doc-kickoff',
  },
  {
    id: 'demo-doc-week2',
    workspaceId: DEMO_GRANOLA_WORKSPACE.id,
    title: 'Harbor weekly sync — Week 2',
    createdAt: '2026-09-09T15:00:00.000Z',
    updatedAt: '2026-09-09T16:00:00.000Z',
    hasTranscript: true,
    participants: [MAYA, DEREK, JORDAN, SAM],
    url: 'https://granola.ai/d/demo-doc-week2',
  },
  {
    id: 'demo-doc-week3',
    workspaceId: DEMO_GRANOLA_WORKSPACE.id,
    title: 'Harbor weekly sync — Week 3',
    createdAt: '2026-09-16T15:00:00.000Z',
    updatedAt: '2026-09-16T16:00:00.000Z',
    hasTranscript: true,
    participants: [MAYA, DEREK, JORDAN, SAM],
    url: 'https://granola.ai/d/demo-doc-week3',
  },
  {
    id: 'demo-doc-exec-recap',
    workspaceId: DEMO_GRANOLA_WORKSPACE.id,
    title: 'Lucerne Health exec check-in — Harbor recap',
    createdAt: '2026-09-18T13:00:00.000Z',
    updatedAt: '2026-09-18T13:30:00.000Z',
    hasTranscript: false,
    participants: [NINA],
    url: 'https://granola.ai/d/demo-doc-exec-recap',
  },
  {
    id: 'demo-doc-week4',
    workspaceId: DEMO_GRANOLA_WORKSPACE.id,
    title: 'Harbor weekly sync — Week 4',
    createdAt: '2026-09-23T15:00:00.000Z',
    updatedAt: '2026-09-23T16:00:00.000Z',
    hasTranscript: true,
    participants: [MAYA, JORDAN, SAM],
    url: 'https://granola.ai/d/demo-doc-week4',
  },
];

export const DEMO_GRANOLA_TRANSCRIPTS: Record<string, GranolaTranscript> = {
  'demo-doc-kickoff': {
    documentId: 'demo-doc-kickoff',
    segments: [
      {
        speaker: 'Maya Okafor',
        text: "Thanks everyone for making time. Let's kick off Project Harbor — modernizing eligibility checks and claims reconciliation ahead of Q4 open enrollment.",
        start: 0,
      },
      {
        speaker: 'Priya Natarajan',
        text: 'One open question from our security team: when do we need to have SOC 2 Type II coverage for the new eligibility-check API? Legal is asking.',
        start: 20,
      },
      {
        speaker: 'Jordan Ames',
        text: "Good question — we'll scope the SOC 2 timeline properly, but it shouldn't block the prototype.",
        start: 35,
      },
      {
        speaker: 'Jordan Ames',
        text: 'Fathom commits to a working prototype of the eligibility-check API within two weeks, so you have something to test against before the Friday sync.',
        start: 50,
      },
      { speaker: 'Maya Okafor', text: "That works for us. Let's reconvene next week.", start: 70 },
    ],
  },
  'demo-doc-week2': {
    documentId: 'demo-doc-week2',
    segments: [
      {
        speaker: 'Maya Okafor',
        text: 'Week two check-in. Jordan, where are we on the eligibility-check API?',
        start: 0,
      },
      {
        speaker: 'Jordan Ames',
        text: 'Prototype is solid. We decided to ship the eligibility-check API behind a feature flag by September 30th, ahead of open enrollment.',
        start: 15,
      },
      {
        speaker: 'Derek Lindqvist',
        text: "One risk I want to flag: our claims reconciliation batch job hasn't been load-tested anywhere near open-enrollment volume. At 3x normal volume I'm worried about the SLA.",
        start: 35,
      },
      {
        speaker: 'Maya Okafor',
        text: "Noted, let's track that. What's the status on the legacy claims DB migration?",
        start: 55,
      },
      {
        speaker: 'Sam Whitfield',
        text: "Migration's blocked — we're waiting on Lucerne's schema audit sign-off before we can cut over the legacy claims tables.",
        start: 70,
      },
    ],
  },
  'demo-doc-week3': {
    documentId: 'demo-doc-week3',
    segments: [
      {
        speaker: 'Derek Lindqvist',
        text: "Following up on the reconciliation SLA risk from last week — I'm still concerned batch reconciliation won't hold up at 3x volume during open enrollment.",
        start: 0,
      },
      {
        speaker: 'Jordan Ames',
        text: 'Good news — we load-tested batch reconciliation at 3x volume this week and it held up fine, well within the SLA. I think that risk is resolved.',
        start: 20,
      },
      {
        speaker: 'Maya Okafor',
        text: "Great, let's make sure we'd catch it early if that changes. Can someone stand up a monitoring dashboard for the eligibility-check API?",
        start: 40,
      },
      {
        speaker: 'Sam Whitfield',
        text: "I'll take the monitoring dashboard as an action item.",
        start: 55,
      },
    ],
  },
  'demo-doc-week4': {
    documentId: 'demo-doc-week4',
    segments: [
      {
        speaker: 'Jordan Ames',
        text: 'The eligibility-check API flag is live at 10% of traffic as of this morning, no issues so far.',
        start: 0,
      },
      {
        speaker: 'Maya Okafor',
        text: 'Good. Lucerne commits to running UAT signoff and a go/no-go review before we ramp past 10%.',
        start: 20,
      },
      {
        speaker: 'Sam Whitfield',
        text: "I'll have the monitoring dashboard numbers ready for that review.",
        start: 40,
      },
    ],
  },
};

export const DEMO_GRANOLA_BODIES: Record<string, string> = {
  // The only `hasTranscript: false` document — its body comes from
  // `getDocumentBody`, never a transcript.
  'demo-doc-exec-recap':
    "Exec recap for Nina Torres: Project Harbor is on track for the Sep 30 flagged rollout. SOC 2 scoping is underway. The reconciliation load test passed at 3x volume. The legacy claims DB migration is blocked pending schema audit sign-off from Lucerne's data team.",
};

// --- Linear ----------------------------------------------------------------

export const DEMO_LINEAR_WORKSPACE: LinearWorkspace = {
  id: 'org-lucerne-harbor',
  name: 'Lucerne Health — Project Harbor',
  memberIds: [LU_JORDAN.id, LU_SAM.id, LU_MAYA.id, LU_DEREK.id, LU_PRIYA.id],
};

/**
 * `demo-harbor-1`'s description deliberately does NOT carry an
 * `fde:decision:` marker here — `orchestrate()` appends
 * `fde:decision:<real fact uuid>` at seed time, once extraction has produced
 * the Week 2 decision fact. See `DemoDefinition.linear.decisionMarker`.
 */
export const DEMO_LINEAR_ISSUES: LinearIssue[] = [
  {
    id: 'demo-harbor-1',
    identifier: 'HARBOR-1',
    title: 'Ship eligibility-check API behind feature flag',
    description: 'Implements the Week 2 rollout decision.',
    state: 'In Progress',
    url: 'https://linear.app/lucerne-harbor/issue/HARBOR-1',
    createdAt: '2026-09-10T14:00:00.000Z',
    updatedAt: '2026-09-10T15:00:00.000Z',
    assignee: LU_JORDAN,
    creator: LU_MAYA,
    priorityLabel: 'High',
    teamKey: 'HARBOR',
  },
  {
    id: 'demo-harbor-2',
    identifier: 'HARBOR-2',
    title: 'Load-test batch reconciliation at 3x volume',
    description: 'Validates the reconciliation SLA risk raised in Week 2.',
    state: 'Done',
    url: 'https://linear.app/lucerne-harbor/issue/HARBOR-2',
    createdAt: '2026-09-10T14:10:00.000Z',
    updatedAt: '2026-09-16T10:00:00.000Z',
    assignee: LU_DEREK,
    creator: LU_DEREK,
    priorityLabel: 'High',
    teamKey: 'HARBOR',
  },
  {
    id: 'demo-harbor-3',
    identifier: 'HARBOR-3',
    title: 'Legacy claims DB migration runbook',
    description: "Blocked on schema audit sign-off from Lucerne's data team.",
    state: 'Todo',
    url: 'https://linear.app/lucerne-harbor/issue/HARBOR-3',
    createdAt: '2026-09-10T14:20:00.000Z',
    updatedAt: '2026-09-10T14:20:00.000Z',
    assignee: LU_SAM,
    creator: LU_MAYA,
    priorityLabel: 'Medium',
    teamKey: 'HARBOR',
  },
  {
    id: 'demo-harbor-4',
    identifier: 'HARBOR-4',
    title: 'SOC 2 audit scope for new API',
    description: 'Answers the SOC 2 Type II timing question raised at kickoff.',
    state: 'Backlog',
    url: 'https://linear.app/lucerne-harbor/issue/HARBOR-4',
    createdAt: '2026-09-10T14:30:00.000Z',
    updatedAt: '2026-09-10T14:30:00.000Z',
    assignee: LU_PRIYA,
    creator: LU_JORDAN,
    priorityLabel: 'Medium',
    teamKey: 'HARBOR',
  },
  {
    id: 'demo-harbor-5',
    identifier: 'HARBOR-5',
    title: 'Stand up eligibility-check monitoring dashboard',
    description: 'Action item from the Week 3 sync.',
    state: 'In Progress',
    url: 'https://linear.app/lucerne-harbor/issue/HARBOR-5',
    createdAt: '2026-09-17T09:00:00.000Z',
    updatedAt: '2026-09-17T09:00:00.000Z',
    assignee: LU_SAM,
    creator: LU_MAYA,
    priorityLabel: null,
    teamKey: 'HARBOR',
  },
  {
    id: 'demo-harbor-6',
    identifier: 'HARBOR-6',
    title: 'UAT signoff checklist for go/no-go review',
    description: 'Supports the Week 4 go/no-go commitment.',
    state: 'Todo',
    url: 'https://linear.app/lucerne-harbor/issue/HARBOR-6',
    createdAt: '2026-09-24T09:00:00.000Z',
    updatedAt: '2026-09-24T09:00:00.000Z',
    assignee: LU_PRIYA,
    creator: LU_MAYA,
    priorityLabel: 'High',
    teamKey: 'HARBOR',
  },
  {
    id: 'demo-harbor-7',
    identifier: 'HARBOR-7',
    title: 'Post-launch eligibility-check bug bash',
    description: null,
    state: 'Backlog',
    url: 'https://linear.app/lucerne-harbor/issue/HARBOR-7',
    createdAt: '2026-09-24T09:10:00.000Z',
    updatedAt: '2026-09-24T09:10:00.000Z',
    assignee: null,
    creator: LU_JORDAN,
    priorityLabel: 'Low',
    teamKey: 'HARBOR',
  },
];
