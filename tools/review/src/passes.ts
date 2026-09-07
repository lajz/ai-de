import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { complete, extractJson } from './provider.js';
import {
  SEVERITIES,
  type Config,
  type Finding,
  type PriorFinding,
  type Retraction,
  type Severity,
} from './types.js';

const PROMPT_DIR = join(import.meta.dirname, '..', 'prompts');

interface RawFinding {
  severity?: unknown;
  file?: unknown;
  line?: unknown;
  title?: unknown;
  detail?: unknown;
  suggestion?: unknown;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function severity(value: unknown): Severity {
  return SEVERITIES.includes(value as Severity) ? (value as Severity) : 'low';
}

function line(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function normalize(raw: RawFinding[], pass: string): Finding[] {
  return raw
    .filter((f): f is RawFinding => !!f && typeof f === 'object')
    .map((f) => ({
      severity: severity(f.severity),
      file: str(f.file, '(unspecified)'),
      line: line(f.line),
      title: str(f.title, 'Unlabeled finding'),
      detail: str(f.detail),
      suggestion: str(f.suggestion),
      pass,
    }))
    .filter((f) => f.detail.length > 0);
}

const rank = (s: Severity): number => SEVERITIES.indexOf(s);

const slug = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * Collapse the near-duplicate findings the model sometimes emits — the same issue
 * described twice, or once per pass. Two findings merge only when they clearly
 * name the same thing: same file + same line, or same file + same title. The more
 * severe one wins; distinct findings on adjacent lines are kept.
 */
export function dedupeFindings(findings: Finding[]): Finding[] {
  const kept: Finding[] = [];
  for (const f of [...findings].sort((a, b) => rank(a.severity) - rank(b.severity))) {
    const dup = kept.some(
      (k) =>
        k.file === f.file &&
        ((f.line != null && k.line === f.line) || slug(k.title) === slug(f.title)),
    );
    if (!dup) kept.push(f);
  }
  return kept;
}

export interface PassResult {
  findings: Finding[];
  retractions: Retraction[];
}

function priorBlock(prior: PriorFinding[]): string {
  const list = prior
    .map((p, i) => `[${i + 1}] ${p.file}${p.line ? `:${p.line}` : ''} — ${p.title}`)
    .join('\n');
  return (
    `\n\n--- Findings you raised on an EARLIER commit of this PR, still open ---\n${list}\n\n` +
    `Re-check each against the current diff. If one is genuinely a false positive ` +
    `or already resolved, add it to a "retractions" array as ` +
    `{"n": <the number>, "reason": "<one sentence>"}. Only retract what is actually ` +
    `wrong — not something you merely wouldn't raise now.`
  );
}

/** Run one review pass (prompt file name without extension) over the diff. */
export async function runPass(
  name: string,
  diff: string,
  cfg: Config,
  prior: PriorFinding[] = [],
): Promise<PassResult> {
  const system = readFileSync(join(PROMPT_DIR, `${name}.md`), 'utf8');
  const user =
    `Here is the unified diff to review:\n\n${diff}` + (prior.length ? priorBlock(prior) : '');
  const content = await complete(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    cfg,
  );
  const parsed = extractJson<{
    findings?: RawFinding[];
    retractions?: { n?: unknown; reason?: unknown }[];
  }>(content);

  const retractions: Retraction[] = [];
  for (const r of Array.isArray(parsed.retractions) ? parsed.retractions : []) {
    const n = typeof r.n === 'number' ? r.n : Number(r.n);
    const target = Number.isInteger(n) ? prior[n - 1] : undefined;
    const reason = str(r.reason);
    if (target && reason) retractions.push({ key: target.key, reason });
  }

  return {
    findings: normalize(Array.isArray(parsed.findings) ? parsed.findings : [], name),
    retractions,
  };
}
