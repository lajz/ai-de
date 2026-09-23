/**
 * Minimal SSE frame parser for a `fetch()`-consumed stream (not `EventSource`,
 * which can't send a POST body — see `AskPanel`). Yields each event's `data:`
 * payload as a raw string; multi-line `data:` fields are joined with `\n` per
 * the SSE spec. Good enough for `@fde/api`'s `@Sse()` output, which never
 * sets `id`/`event` — every frame is a single JSON `data:` line.
 */
export async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep = buffer.indexOf('\n\n');
      while (sep !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n');
        if (data) yield data;
        sep = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}
