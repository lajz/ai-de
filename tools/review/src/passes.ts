import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { complete, extractJson } from './provider.js';
import { SEVERITIES, type Config, type Finding, type Severity } from './types.js';

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

/** Run one review pass (prompt file name without extension) over the diff. */
export async function runPass(name: string, diff: string, cfg: Config): Promise<Finding[]> {
  const system = readFileSync(join(PROMPT_DIR, `${name}.md`), 'utf8');
  const content = await complete(
    [
      { role: 'system', content: system },
      { role: 'user', content: `Here is the unified diff to review:\n\n${diff}` },
    ],
    cfg,
  );
  const parsed = extractJson<{ findings?: RawFinding[] }>(content);
  return normalize(Array.isArray(parsed.findings) ? parsed.findings : [], name);
}
