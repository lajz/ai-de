/**
 * Marker convention linking a connector-ingested work item back to a decision
 * fact: a literal `fde:decision:<id>` token anywhere in free text (a Linear
 * issue description, a GitHub PR body, …). No NLP, no heuristics — the link is
 * explicit or it is absent. `<id>` is matched against the decision fact's
 * external ref during graph load; an unresolved marker is dropped there, not
 * here.
 *
 * Shared by every connector that wants a `(decision)-[implemented_by]->(work_item)`
 * edge (Linear, GitHub) — one convention, one regex, one place to extend it.
 *
 * Follow-up: also accept an `fde` fact permalink URL once the web app's fact
 * routes are stable.
 */
export const DECISION_MARKER = /fde:decision:([A-Za-z0-9._-]+)/g;

/** Every distinct decision id marked in `text`, in first-seen order. */
export function extractDecisionRefs(text: string | null | undefined): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  for (const m of text.matchAll(DECISION_MARKER)) {
    if (m[1]) seen.add(m[1]);
  }
  return [...seen];
}
