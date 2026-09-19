import type { FactType } from '@fde/core';
import type {
  GranolaDocument,
  GranolaTranscript,
  GranolaWorkspace,
  LinearIssue,
  LinearWorkspace,
} from '@fde/connectors';

/**
 * The plugin contract every demo implements. `orchestrate()` (in this
 * directory's `orchestrate.ts`) is generic over this shape — it contains no
 * literal from any one demo's story. Adding a new demo means adding one
 * `demos/<slug>/` folder that exports one `DemoDefinition`, plus one line in
 * `demos/index.ts`; nothing here, in `orchestrate.ts`, or in any other demo's
 * folder needs to change.
 */
export interface DemoDefinition {
  /** CLI-facing id ("lucerne-health") — also the idempotency key alongside `endCustomerName` */
  slug: string;
  /** shown in the `/` engagement list, e.g. "Lucerne Health — Project Harbor" */
  endCustomerName: string;
  granola: {
    workspace: GranolaWorkspace;
    documents: GranolaDocument[];
    transcripts: Record<string, GranolaTranscript>;
    /** notes-panel body — only read back for `hasTranscript: false` documents */
    bodies?: Record<string, string>;
  };
  linear: {
    workspace: LinearWorkspace;
    /**
     * The issue named in `decisionMarker.issueId` must NOT carry the
     * `fde:decision:` marker in its `description` here — `orchestrate()`
     * appends it once the real decision fact exists. A fact's id doesn't
     * exist until after extraction runs, so it can never be a fixture
     * literal (that dangling-marker bug is exactly what this whole demo
     * dataset exists to prove is fixed).
     */
    issues: LinearIssue[];
    decisionMarker: {
      /** the Linear issue (by `LinearIssue.id`) that gets `fde:decision:<uuid>` appended */
      issueId: string;
      /** the Granola document (by `GranolaDocument.id`) whose extraction should yield the fact */
      sourceDocExternalId: string;
      factType: FactType;
    };
  };
  /** printed in the run summary, and used for the browser verification pass */
  qaQuestions: DemoQaQuestion[];
}

export interface DemoQaQuestion {
  question: string;
  /** the Granola doc id the answer's citation is expected to point back at */
  expectDocId?: string;
  /** true for a deliberate miss — the retrieval flow should decline to answer */
  expectNoAnswer?: boolean;
}
