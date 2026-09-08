import { createHash } from 'node:crypto';

/**
 * Character-window chunking for the extraction pass. Token-aware chunking is a
 * documented later refinement (`docs/ROADMAP.md` #8 / #11); a char window is
 * predictable, dependency-free, and good enough for a single meeting transcript.
 */
export interface ChunkOptions {
  /** Hard ceiling on a chunk's length in characters. Default ~4000. */
  maxChars?: number;
  /** Characters of the previous chunk repeated at the start of the next. Default ~200. */
  overlapChars?: number;
}

export interface TranscriptChunk {
  /**
   * Stable id for this chunk, used as `embeddings.chunk_ref`. Derived from a hash
   * of the *full* text plus the chunk index, so re-running extraction on the same
   * transcript yields the same refs (idempotent embeds).
   */
  ref: string;
  text: string;
  /**
   * Start index of this chunk in the full text. Model evidence spans are
   * chunk-local; add `offset` to translate them back to source-document offsets.
   */
  offset: number;
}

const DEFAULT_MAX_CHARS = 4000;
const DEFAULT_OVERLAP_CHARS = 200;

/**
 * Split `text` into overlapping character windows, preferring to break on a line
 * boundary inside the window (transcripts are one speaker-tagged line per turn,
 * so a line break is a clean cut). Pure: no IO, unit-tested in isolation.
 */
export function chunkTranscript(text: string, opts: ChunkOptions = {}): TranscriptChunk[] {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  if (!Number.isInteger(maxChars) || maxChars <= 0) {
    throw new RangeError(`chunkTranscript: maxChars must be a positive integer, got ${maxChars}`);
  }
  // Default overlap is a fraction of the window, so a small custom maxChars never
  // collides with the default (an explicit overlapChars is still validated).
  const overlapChars =
    opts.overlapChars ?? Math.min(DEFAULT_OVERLAP_CHARS, Math.floor(maxChars / 4));
  if (!Number.isInteger(overlapChars) || overlapChars < 0 || overlapChars >= maxChars) {
    throw new RangeError(
      `chunkTranscript: overlapChars must be an integer in [0, maxChars), got ${overlapChars}`,
    );
  }

  const digest = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
  if (text.length === 0) return [];
  if (text.length <= maxChars) return [{ ref: `${digest}:0`, text, offset: 0 }];

  const chunks: TranscriptChunk[] = [];
  let start = 0;
  for (let i = 0; start < text.length; i++) {
    let end = Math.min(start + maxChars, text.length);
    // Snap `end` back to the last line break in the window — but only when that
    // still leaves a reasonably full chunk, so a newline near `start` can't
    // shred the transcript into slivers.
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end);
      if (nl > start && nl - start >= maxChars / 2) end = nl + 1;
    }
    chunks.push({ ref: `${digest}:${i}`, text: text.slice(start, end), offset: start });
    if (end >= text.length) break;
    // Always make progress even if overlap would otherwise stall us.
    start = Math.max(end - overlapChars, start + 1);
  }
  return chunks;
}
