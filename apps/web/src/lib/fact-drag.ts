/**
 * The drag-and-drop contract between `FactList` (drag source) and `AskPanel`
 * (drop target) — dragging a fact card onto the chat composer references it
 * in the next question. A custom MIME type, not a bare string, so a drag
 * from somewhere else in the browser (a text selection, a link) is never
 * mistaken for a fact reference.
 */
export const FACT_DRAG_MIME = 'application/x-fde-fact';

export interface FactDragPayload {
  factId: string;
  summary: string;
}

export function serializeFactDrag(payload: FactDragPayload): string {
  return JSON.stringify(payload);
}

/** `null` on anything that isn't a well-formed `FactDragPayload` — never throws. */
export function parseFactDrag(raw: string): FactDragPayload | null {
  try {
    const parsed = JSON.parse(raw) as Partial<FactDragPayload>;
    if (typeof parsed.factId === 'string' && typeof parsed.summary === 'string') {
      return { factId: parsed.factId, summary: parsed.summary };
    }
  } catch {
    // not JSON, or not shaped like a FactDragPayload — not a fact drag
  }
  return null;
}
