import { describe, expect, it } from 'vitest';

import { chunkTranscript } from './chunk-transcript.js';

describe('chunkTranscript', () => {
  it('returns nothing for empty text and a single chunk when it fits', () => {
    expect(chunkTranscript('')).toEqual([]);
    expect(chunkTranscript('short line', { maxChars: 100 })).toEqual([
      { ref: expect.stringMatching(/^[0-9a-f]{12}:0$/), text: 'short line', offset: 0 },
    ]);
  });

  it('windows long text with overlap, and offsets index into the original', () => {
    const text = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n');
    const chunks = chunkTranscript(text, { maxChars: 80, overlapChars: 20 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(text.slice(c.offset, c.offset + c.text.length)).toBe(c.text);
      expect(c.text.length).toBeLessThanOrEqual(80);
    }
    // consecutive chunks overlap (next starts before the previous one ends)
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.offset).toBeLessThan(chunks[i - 1]!.offset + chunks[i - 1]!.text.length);
      expect(chunks[i]!.offset).toBeGreaterThan(chunks[i - 1]!.offset);
    }
    // the tail of the transcript is covered
    const last = chunks.at(-1)!;
    expect(last.offset + last.text.length).toBe(text.length);
  });

  it('prefers to break on a line boundary inside the window', () => {
    const text = `${'a'.repeat(50)}\n${'b'.repeat(50)}\n${'c'.repeat(50)}`;
    const [first] = chunkTranscript(text, { maxChars: 90, overlapChars: 0 });
    expect(first!.text).toBe(`${'a'.repeat(50)}\n`);
  });

  it('ref is stable across runs and unique per index; changes with the text', () => {
    const text = Array.from({ length: 40 }, (_, i) => `turn ${i}`).join('\n');
    const a = chunkTranscript(text, { maxChars: 60, overlapChars: 10 });
    const b = chunkTranscript(text, { maxChars: 60, overlapChars: 10 });
    expect(a.map((c) => c.ref)).toEqual(b.map((c) => c.ref));
    expect(new Set(a.map((c) => c.ref)).size).toBe(a.length);

    const [other] = chunkTranscript(`${text} changed`, { maxChars: 60, overlapChars: 10 });
    expect(other!.ref).not.toBe(a[0]!.ref);
  });

  it('rejects nonsensical options', () => {
    expect(() => chunkTranscript('x', { maxChars: 0 })).toThrow(RangeError);
    expect(() => chunkTranscript('x', { maxChars: 100, overlapChars: 100 })).toThrow(RangeError);
    expect(() => chunkTranscript('x', { maxChars: 100, overlapChars: -1 })).toThrow(RangeError);
  });
});
