import type { FactType } from '@fde/core';
import { renderTranscriptText } from '@fde/workers/activities/transcript-source.js';
import type { TranscriptSegment } from '@fde/workers/capture/recall-client.js';

/**
 * A recorded meeting fixture for the M1 end-to-end test — written for this
 * harness, no real data. A weekly sync between an Acme FDE team and their design
 * partner "Northwind Health", carrying a handful of clear decisions / action
 * items / risks / commitments for the extraction pass to pick up.
 *
 * The fixture is the single source of truth for the run: {@link FIXTURE_SEGMENTS}
 * is fed to `FakeRecallClient`, and {@link EXPECTED_FACTS} drives both the
 * deterministic extraction stand-in (`fixtures/canned-router.ts`) and the
 * assertions in `m1-pipeline.e2e.test.ts`. Nothing here calls a real LLM — the
 * extraction *quality* gate is `@fde/eval`; this test exercises the pipeline,
 * the crypto boundary, and the read path.
 */

interface Turn {
  speaker: string;
  /** single-spaced; becomes one speaker-tagged line in the rendered transcript */
  text: string;
}

const TURNS: Turn[] = [
  {
    speaker: 'Priya Nair',
    text: "Thanks everyone for joining the Northwind weekly sync. Let's start with the data store decision we left open last week.",
  },
  {
    speaker: 'Dana Liu',
    text: 'I ran the load tests against both options. Postgres with pgvector handled our claims-intake volume comfortably and the relational queries are much simpler.',
  },
  {
    speaker: 'Marcus Webb',
    text: 'That matches what my team expected. DynamoDB would have meant rewriting the reporting layer.',
  },
  {
    speaker: 'Priya Nair',
    text: 'Then we will standardize on Postgres for the pilot data store, not DynamoDB. I will record that as the decision.',
  },
  {
    speaker: 'Dana Liu',
    text: 'Works for me. I will send the updated integration runbook to Northwind by Thursday so your engineers can start wiring the connector.',
  },
  {
    speaker: 'Tom Alvarez',
    text: 'On security — the SSO migration to the new identity provider is still not approved on our side. If that change is not approved this week the pilot start date could slip.',
  },
  {
    speaker: 'Marcus Webb',
    text: 'I hear the risk. I will get the identity provider change request approved by Friday, I will escalate to the CISO today if I have to.',
  },
  {
    speaker: 'Priya Nair',
    text: 'Good. One more scope point — for the pilot we are locking the scope to the claims-intake workflow only, everything else waits for phase two.',
  },
  {
    speaker: 'Tom Alvarez',
    text: 'Agreed. Narrower scope makes the security review tractable.',
  },
  {
    speaker: 'Priya Nair',
    text: 'Great, that is everything. I will circulate notes after the call.',
  },
];

/** Recall-shaped segments: word-level timing, deterministic fake timestamps. */
function toSegment({ speaker, text }: Turn, startSec: number): TranscriptSegment {
  let t = startSec;
  const words = text.split(' ').map((word) => {
    const w = { text: word, start: Number(t.toFixed(2)), end: Number((t + 0.3).toFixed(2)) };
    t += 0.4;
    return w;
  });
  return { speaker, words };
}

export const FIXTURE_SEGMENTS: TranscriptSegment[] = TURNS.map((turn, i) =>
  toSegment(turn, i * 20),
);

/** The plaintext the extraction pass sees — `renderTranscriptText(FIXTURE_SEGMENTS)`. */
export const FIXTURE_TRANSCRIPT_TEXT: string = renderTranscriptText(FIXTURE_SEGMENTS);

export const FIXTURE_MEETING_URL = 'https://meet.example.com/northwind-weekly-sync';

export interface ExpectedFact {
  type: FactType;
  /** verbatim span of {@link FIXTURE_TRANSCRIPT_TEXT} — must resolve to a char span */
  quote: string;
  /** distinctive phrase asserted to survive into the (cleartext) `facts.summary` */
  summaryPhrase: string;
  /** goes into the encrypted `facts.body`; asserted to decrypt back out */
  detail: string;
}

export const EXPECTED_FACTS: ExpectedFact[] = [
  {
    type: 'decision',
    quote: 'we will standardize on Postgres for the pilot data store, not DynamoDB',
    summaryPhrase: 'Postgres',
    detail:
      'The team chose Postgres with pgvector over DynamoDB for the pilot data store, citing simpler relational queries and no reporting-layer rewrite.',
  },
  {
    type: 'action_item',
    quote: 'I will send the updated integration runbook to Northwind by Thursday',
    summaryPhrase: 'integration runbook',
    detail: 'Dana Liu to send Northwind the updated integration runbook by Thursday.',
  },
  {
    type: 'risk',
    quote: 'If that change is not approved this week the pilot start date could slip',
    summaryPhrase: 'pilot start date',
    detail:
      'The Northwind SSO migration to the new identity provider is unapproved; if it is not approved this week the pilot start date could slip.',
  },
  {
    type: 'commitment',
    quote: 'I will get the identity provider change request approved by Friday',
    summaryPhrase: 'identity provider change request',
    detail:
      'Marcus Webb committed to getting the identity provider change request approved by Friday.',
  },
  {
    type: 'decision',
    quote: 'we are locking the scope to the claims-intake workflow only',
    summaryPhrase: 'claims-intake workflow',
    detail:
      'Pilot scope is locked to the claims-intake workflow only; everything else is deferred to phase two.',
  },
];

/** Fixture self-check: every expected quote must be locatable in the transcript. */
for (const f of EXPECTED_FACTS) {
  if (!FIXTURE_TRANSCRIPT_TEXT.includes(f.quote)) {
    throw new Error(
      `meeting-transcript fixture: expected quote is not a verbatim span of the transcript: ${JSON.stringify(
        f.quote,
      )}`,
    );
  }
}

/** char span of an expected quote within the rendered transcript. */
export function spanOf(quote: string): { charStart: number; charEnd: number } {
  const charStart = FIXTURE_TRANSCRIPT_TEXT.indexOf(quote);
  return { charStart, charEnd: charStart + quote.length };
}
