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
  baseUrl: string;
  model: string;
  apiKey: string | null;
  /** Diff larger than this (bytes) is truncated file-by-file before sending. */
  maxDiffBytes: number;
  /** Findings below this severity are dropped from the report. */
  minSeverity: Severity;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
  /** Passes to run. */
  passes: { review: boolean; security: boolean };
}

export interface ReviewContext {
  base: string;
  head: string;
  changedFiles: string[];
  truncatedFiles: string[];
}

export interface Sink {
  emit(findings: Finding[], ctx: ReviewContext): Promise<void>;
}
