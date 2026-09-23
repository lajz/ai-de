import { describe, expect, it } from 'vitest';

import { parseSseStream } from './sse';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i]!));
        i += 1;
      } else {
        controller.close();
      }
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const data of parseSseStream(stream)) out.push(data);
  return out;
}

describe('parseSseStream', () => {
  it('yields the data payload of each frame', async () => {
    const stream = streamOf(['data: {"type":"tool_step"}\n\n', 'data: {"type":"answer"}\n\n']);
    expect(await collect(stream)).toEqual(['{"type":"tool_step"}', '{"type":"answer"}']);
  });

  it('reassembles a frame split across multiple chunks', async () => {
    const stream = streamOf([
      'data: {"type"',
      ':"tool_step"}\n',
      '\n',
      'data: {"type":"answer"}\n\n',
    ]);
    expect(await collect(stream)).toEqual(['{"type":"tool_step"}', '{"type":"answer"}']);
  });

  it('joins a multi-line data field with newlines', async () => {
    const stream = streamOf(['data: line one\ndata: line two\n\n']);
    expect(await collect(stream)).toEqual(['line one\nline two']);
  });

  it('ignores a trailing frame with no data field', async () => {
    const stream = streamOf(['data: {"type":"answer"}\n\n', ': keep-alive comment\n\n']);
    expect(await collect(stream)).toEqual(['{"type":"answer"}']);
  });

  it('yields nothing for an empty stream', async () => {
    expect(await collect(streamOf([]))).toEqual([]);
  });
});
