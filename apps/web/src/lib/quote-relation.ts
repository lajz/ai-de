/**
 * Whether an evidence quote reads as the same words as the fact it's cited
 * for, or as a genuinely different (condensed/paraphrased) rendering of it.
 * Lets the UI tell "the extraction wrote this" apart from "this is verbatim
 * from the source" instead of showing near-identical sentences with no cue.
 */
export type QuoteRelation = 'verbatim' | 'condensed' | 'unavailable';

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function describeQuoteRelation(
  quote: string | null,
  fact: { summary: string; body: string | null },
): QuoteRelation {
  if (!quote) return 'unavailable';
  const q = normalize(quote);
  if (!q) return 'unavailable';

  const candidates = [fact.summary, fact.body].filter((c): c is string => Boolean(c));
  const isVerbatim = candidates.some((c) => {
    const n = normalize(c);
    return n.length > 0 && (n.includes(q) || q.includes(n));
  });
  return isVerbatim ? 'verbatim' : 'condensed';
}
