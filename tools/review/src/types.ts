export type Severity = 'high' | 'medium' | 'low' | 'nit';

export const SEVERITIES: readonly Severity[] = ['high', 'medium', 'low', 'nit'];

export interface Finding {
  severity: Severity;
  file: string;
  line: number | null;
  title: string;
  detail: string;
  suggestion: string;
  /** Which pass produced it — 'review' or 'security'. */
  pass: string;
}

export interface Config {
  /** Git ref (or SHA) the diff is taken against. */
  baseRef: string | null;
  /** Head of the diff (default HEAD). CI sets this to a fetched-but-not-checked-out sha. */
  headRef: string | null;
  baseUrl: string;
  model: string;
  apiKey: string | null;
  /** Diff larger than this (bytes) is truncated file-by-file before sending. */
  maxDiffBytes: number;
  /** Findings below this severity are dropped from the report. */
  minSeverity: Severity;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
  /** Cap on completion tokens per model call. A large PR can need the full budget
   * to emit its findings JSON; hitting it reads as a truncation failure. */
  maxTokens: number;
  /** Extra attempts after the first on a transient failure (timeout, network, 5xx, 429). */
  retries: number;
  /** Passes to run. */
  passes: { review: boolean; security: boolean };
  /** Findings at or above this severity block PR approval (github sink). */
  blockingSeverity: Severity;
  /** If set, exit non-zero when a finding at or above this severity is present. */
  failOn: Severity | null;
}

export interface ReviewContext {
  base: string;
  head: string;
  changedFiles: string[];
  truncatedFiles: string[];
}

/** An open finding from an earlier commit, handed to a pass so it can reconsider it. */
export interface PriorFinding {
  key: string;
  pass: string;
  file: string;
  line: number | null;
  title: string;
  detail: string;
}

/** A pass retracting one of its own earlier findings as a false positive. */
export interface Retraction {
  key: string;
  reason: string;
}

export interface Sink {
  emit(findings: Finding[], ctx: ReviewContext, retractions?: Retraction[]): Promise<void>;
}
