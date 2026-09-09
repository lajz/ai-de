import type { Aggregate, FixtureScore } from './scorer.js';

export interface EvalReport {
  promptVersion: string;
  model: string;
  perFixture: FixtureScore[];
  aggregate: Aggregate;
}

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

export function formatReport(report: EvalReport): string {
  const row = (
    label: string,
    s: Pick<FixtureScore, 'precision' | 'recall' | 'phraseRecall'>,
  ): string =>
    `  ${label.padEnd(30)} P ${pct(s.precision).padStart(7)}  R ${pct(s.recall).padStart(7)}  phrases ${pct(s.phraseRecall).padStart(7)}`;
  return [
    `prompt ${report.promptVersion}   model ${report.model}`,
    '',
    ...report.perFixture.map((s) => row(s.id, s)),
    '',
    row('AGGREGATE', report.aggregate),
  ].join('\n');
}
