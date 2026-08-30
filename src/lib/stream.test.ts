import { describe, expect, it, vi } from 'vitest';
import { CreddaError } from './errors.js';
import { Transport } from './http.js';
import { SseDecoder, streamSse } from './stream.js';

/** An SSE response whose body arrives in the given chunks, in order. */
function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}

const frame = (id: number, type: string, data: unknown) =>
  `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

describe('SseDecoder', () => {
  it('decodes a frame the server actually writes', () => {
    const decoder = new SseDecoder();
    const frames = decoder.push(frame(7, 'REPRODUCTION_SUCCEEDED', { sequence: 7, summary: 'reproduced' }));
    expect(frames).toEqual([
      { id: '7', event: 'REPRODUCTION_SUCCEEDED', data: '{"sequence":7,"summary":"reproduced"}' },
    ]);
  });

  it('ignores the heartbeat comment', () => {
    // A 15s `: heartbeat` keeps the connection open and is not an event.
    expect(new SseDecoder().push(': heartbeat\n\n')).toEqual([]);
  });

  it('reassembles a frame split across chunk boundaries', () => {
    const decoder = new SseDecoder();
    const whole = frame(1, 'INVESTIGATION_STARTED', { sequence: 1 });
    const cut = Math.floor(whole.length / 2);
    expect(decoder.push(whole.slice(0, cut))).toEqual([]);
    const frames = decoder.push(whole.slice(cut));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.id).toBe('1');
  });

  it('joins multiple data lines with a newline, per the SSE grammar', () => {
    const frames = new SseDecoder().push('event: x\ndata: one\ndata: two\n\n');
    expect(frames[0]!.data).toBe('one\ntwo');
  });

  it('accepts CRLF line endings', () => {
    const frames = new SseDecoder().push('id: 3\r\nevent: y\r\ndata: {}\r\n\r\n');
    expect(frames[0]).toEqual({ id: '3', event: 'y', data: '{}' });
  });

  it('strips exactly one leading space after the colon', () => {
    const frames = new SseDecoder().push('data:  padded\n\n');
    expect(frames[0]!.data).toBe(' padded');
  });

  it('discards a dispatch with no data line', () => {
    expect(new SseDecoder().push('event: nothing\n\n')).toEqual([]);
  });

  it('defaults a frame with no event field to `message`', () => {
    expect(new SseDecoder().push('data: 1\n\n')[0]!.event).toBe('message');
  });

  it('does not carry an event name into the next frame', () => {
    const decoder = new SseDecoder();
    decoder.push('event: named\ndata: 1\n\n');
    expect(decoder.push('data: 2\n\n')[0]!.event).toBe('message');
  });

  it('ignores fields it does not know, such as retry', () => {
    const frames = new SseDecoder().push('retry: 5000\ndata: 1\n\n');
    expect(frames).toHaveLength(1);
  });
});

describe('streamSse', () => {
  const transport = (fetchImpl: unknown) =>
    new Transport({ baseUrl: 'http://x', apiKey: 'k', fetch: fetchImpl as never });

  it('yields parsed events and opens the stream at the requested cursor', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      sseResponse([frame(4, 'A', { sequence: 4 }), frame(5, 'B', { sequence: 5 })]),
    );
    const received: Array<{ sequence: number }> = [];
    for await (const event of streamSse<{ sequence: number }>(transport(fetchImpl), '/s', { since: 3 })) {
      received.push(event);
    }
    expect(received.map((e) => e.sequence)).toEqual([4, 5]);
    expect(fetchImpl.mock.calls[0]![0]).toBe('http://x/s?since=3');
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    // EventSource cannot set a header, which is why this is read with fetch:
    // every /api route is behind the bearer gate.
    expect(headers['Authorization']).toBe('Bearer k');
    expect(headers['Accept']).toBe('text/event-stream');
    expect(headers['Last-Event-ID']).toBe('3');
  });

  it('ends without reconnecting when the server closes the stream', async () => {
    const fetchImpl = vi.fn(async () => sseResponse([frame(1, 'A', { sequence: 1 })]));
    const seen = [];
    for await (const event of streamSse(transport(fetchImpl), '/s')) seen.push(event);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reopens from the last sequence seen when reconnect is on', async () => {
    // The server drops a stream that has carried nothing for five minutes; a
    // resume must not replay what the consumer already has.
    let call = 0;
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => {
      call += 1;
      if (call === 1) return sseResponse([frame(11, 'A', { sequence: 11 })]);
      return sseResponse([frame(12, 'B', { sequence: 12 })]);
    });
    const received: Array<{ sequence: number }> = [];
    for await (const event of streamSse<{ sequence: number }>(transport(fetchImpl), '/s', {
      reconnect: true,
      reconnectDelayMs: 0,
    })) {
      received.push(event);
      if (received.length === 2) break;
    }
    expect(received.map((e) => e.sequence)).toEqual([11, 12]);
    expect(fetchImpl.mock.calls[1]![0]).toBe('http://x/s?since=11');
  });

  it('stops on the complete frame instead of reconnecting against a finished run', async () => {
    // The defect this guards: `complete` was neither recognised nor stopped on,
    // so with `reconnect` a consumer reopened a finished run, was handed the
    // same backlog and the same frame, and went round for as long as it ran.
    const fetchImpl = vi.fn(async () =>
      sseResponse([
        frame(1, 'A', { sequence: 1 }),
        'event: complete\ndata: {"state":"READY_FOR_REVIEW"}\n\n',
      ]),
    );
    const states: string[] = [];
    const received: Array<{ sequence: number }> = [];
    for await (const event of streamSse<{ sequence: number }>(transport(fetchImpl), '/s', {
      reconnect: true,
      reconnectDelayMs: 0,
      onComplete: (state) => states.push(state),
    })) {
      received.push(event);
    }
    // The terminal state is reported once, and never as an event.
    expect(received.map((e) => e.sequence)).toEqual([1]);
    expect(states).toEqual(['READY_FOR_REVIEW']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reconnects after an idle frame, because the run has not finished', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => {
      call += 1;
      if (call === 1) {
        return sseResponse([
          frame(4, 'A', { sequence: 4 }),
          'event: idle\ndata: {"reason":"no events for five minutes; the run has not reached a terminal state"}\n\n',
        ]);
      }
      return sseResponse([frame(5, 'B', { sequence: 5 })]);
    });
    const received: Array<{ sequence: number }> = [];
    for await (const event of streamSse<{ sequence: number }>(transport(fetchImpl), '/s', {
      reconnect: true,
      reconnectDelayMs: 0,
    })) {
      received.push(event);
      if (received.length === 2) break;
    }
    // The idle frame is not an event, and the resume carries the cursor.
    expect(received.map((e) => e.sequence)).toEqual([4, 5]);
    expect(fetchImpl.mock.calls[1]![0]).toBe('http://x/s?since=4');
  });

  it('turns the revocation frame into a 401, the same answer the gate gives', async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse([
        frame(1, 'A', { sequence: 1 }),
        'event: unauthenticated\ndata: {"reason":"the API key for this stream was revoked"}\n\n',
      ]),
    );
    const iterate = async () => {
      for await (const _event of streamSse(transport(fetchImpl), '/s', { reconnect: true, reconnectDelayMs: 0 })) {
        /* drain */
      }
    };
    await expect(iterate()).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHENTICATED',
      message: 'credda: the API key for this stream was revoked',
    });
    // And it does not reconnect: a revoked key does not become valid on retry.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports a refusal to open as a CreddaError with the API code', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: 'TOO_MANY_STREAMS', message: 'Too many open event streams' } }), {
        status: 503,
      }),
    );
    const iterate = async () => {
      for await (const _event of streamSse(transport(fetchImpl), '/s')) {
        /* drain */
      }
    };
    await expect(iterate()).rejects.toMatchObject({ status: 503, code: 'TOO_MANY_STREAMS' });
  });

  it('reports a body-less response rather than hanging', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const iterate = async () => {
      for await (const _event of streamSse(transport(fetchImpl), '/s')) {
        /* drain */
      }
    };
    await expect(iterate()).rejects.toBeInstanceOf(CreddaError);
  });
});
