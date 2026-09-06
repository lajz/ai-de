import { SEVERITIES, type Finding, type ReviewContext, type Severity, type Sink } from './types.js';

const ESC = String.fromCharCode(27);
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string, s: string): string => (useColor ? `${ESC}[${code}m${s}${ESC}[0m` : s);

const LABEL: Record<Severity, string> = {
  high: paint('31;1', 'HIGH'),
  medium: paint('33;1', 'MEDIUM'),
  low: paint('36', 'LOW'),
  nit: paint('90', 'NIT'),
};

const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2, nit: 3 };

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) => RANK[a.severity] - RANK[b.severity] || a.file.localeCompare(b.file),
  );
}

export function filterBySeverity(findings: Finding[], min: Severity): Finding[] {
  return findings.filter((f) => RANK[f.severity] <= RANK[min]);
}

export function render(findings: Finding[], ctx: ReviewContext, min: Severity): string {
  const lines: string[] = [];
  lines.push(paint('1', `\nAI review — ${ctx.changedFiles.length} file(s) changed vs ${ctx.base}`));
  if (ctx.truncatedFiles.length) {
    lines.push(paint('90', `  (diff truncated; not reviewed: ${ctx.truncatedFiles.join(', ')})`));
  }

  const shown = sortFindings(filterBySeverity(findings, min));
  if (shown.length === 0) {
    lines.push(paint('32', `  no findings at or above severity ${min}`) + '\n');
    return lines.join('\n');
  }

  for (const f of shown) {
    const loc = f.line ? `${f.file}:${f.line}` : f.file;
    lines.push(
      `\n  ${LABEL[f.severity]}  ${paint('1', f.title)}  ${paint('90', `[${f.pass}] ${loc}`)}`,
    );
    lines.push(`    ${f.detail}`);
    if (f.suggestion) lines.push(paint('90', `    fix: ${f.suggestion}`));
  }

  const counts = SEVERITIES.map((s) => {
    const n = findings.filter((f) => f.severity === s).length;
    return n ? `${n} ${s}` : null;
  }).filter(Boolean);
  lines.push(
    paint('1', `\n  ${counts.join(', ') || 'no findings'} — advisory only, push not blocked`) +
      '\n',
  );
  return lines.join('\n');
}

export class TerminalSink implements Sink {
  constructor(private readonly min: Severity) {}

  emit(findings: Finding[], ctx: ReviewContext): Promise<void> {
    process.stdout.write(render(findings, ctx, this.min) + '\n');
    return Promise.resolve();
  }
}
