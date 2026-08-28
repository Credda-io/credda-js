/**
 * The live event stream.
 *
 * `apps/api/src/routes/stream.ts` serves **Server-Sent Events** — `text/event-stream`,
 * `id:`/`event:`/`data:` frames, `: heartbeat` comments every 15s, and
 * `Last-Event-ID` for resumption. It is not a WebSocket and there is no
 * long-polling fallback.
 *
 * It is read here with `fetch` and a stream reader rather than with the
 * browser's `EventSource`, and the reason is the auth gate: every route under
 * `/api` requires `Authorization: Bearer`, and `EventSource` cannot set a
 * request header. `EventSource` can only reach this API on a deployment running
 * `CREDDA_AUTH=disabled`.
 *
 * Two server behaviours a consumer has to know about:
 *  - A stream that has carried no event for five minutes is dropped. That is
 *    not an error, and `reconnect` exists for it.
 *  - If the key that opened the stream is revoked, the server sends an
 *    `unauthenticated` frame and closes. That surfaces here as a `CreddaError`
 *    with status 401 — the same answer the gate gives a new request.
 */

import { CreddaError, toCreddaError } from './errors.js';
import type { Transport } from './http.js';

/** One decoded SSE frame. `id` is the event's sequence; comments never reach here. */
export interface SseFrame {
  id: string | null;
  event: string;
  data: string;
}

/**
 * Decodes an SSE byte stream into frames.
 *
 * Split out and exported so the framing is testable without a server: the
 * dispatch rules (blank line ends a frame, `:` starts a comment, one optional
 * space after the colon, a frame with no `data` is discarded) are where a
 * hand-rolled SSE reader goes wrong.
 */
export class SseDecoder {
  private buffer = '';
  private id: string | null = null;
  private event = '';
  private data: string[] = [];

  /** Feed a chunk of text; returns whatever complete frames it completed. */
  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];
    // Normalise CRLF and lone CR to LF, as the SSE grammar requires.
    const lines = this.buffer.split(/\r\n|\r|\n/);
    // The last element is a partial line unless the chunk ended on a break.
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line === '') {
        const frame = this.take();
        if (frame !== null) frames.push(frame);
        continue;
      }
      if (line.startsWith(':')) continue; // comment: the heartbeat
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'id') this.id = value;
      else if (field === 'event') this.event = value;
      else if (field === 'data') this.data.push(value);
      // `retry` and unknown fields are ignored, per the SSE spec.
    }
    return frames;
  }

  private take(): SseFrame | null {
    if (this.data.length === 0) {
      this.event = '';
      return null;
    }
    const frame: SseFrame = {
      id: this.id,
      event: this.event === '' ? 'message' : this.event,
      data: this.data.join('\n'),
    };
    this.event = '';
    this.data = [];
    return frame;
  }
}

export interface StreamOptions {
  /** Resume after this sequence. 0 (the default) replays the timeline from the start. */
  since?: number | undefined;
  signal?: AbortSignal | undefined;
  /**
   * Reopen the stream when the server closes it, resuming from the last
   * sequence seen. Off by default: a caller that wants one pass over a finished
   * run should get one pass.
   *
   * The server drops a stream after five minutes with no event, so a long, quiet
   * run needs this. It does not reconnect after a 401: a revoked key does not
   * become valid by asking again.
   */
  reconnect?: boolean | undefined;
  /** Delay before reopening. Default 1s. */
  reconnectDelayMs?: number | undefined;
}

/**
 * Yields events off one SSE route until the stream ends (or forever, with
 * `reconnect`). The `sequence` of each event is taken from the SSE `id`, which
 * is what the server frames it with, so a caller can persist a cursor.
 */
export async function* streamSse<T>(
  transport: Transport,
  path: string,
  options: StreamOptions = {},
): AsyncGenerator<T, void, undefined> {
  let since = options.since ?? 0;
  const delay = options.reconnectDelayMs ?? 1_000;

  for (;;) {
    const res = await transport.raw(`${path}?since=${since}`, {
      headers: transport.headers({
        Accept: 'text/event-stream',
        // Redundant with `since` and sent anyway: the server prefers this header
        // when both are present, and it is what makes a resume identical to an
        // EventSource reconnect.
        'Last-Event-ID': String(since),
      }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    if (!res.ok) throw await toCreddaError(res, path);
    if (res.body === null) throw new CreddaError(0, 'stream response carried no body', path);

    const decoder = new SseDecoder();
    const reader = res.body.getReader();
    const text = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const frame of decoder.push(text.decode(value, { stream: true }))) {
          if (frame.event === 'unauthenticated') {
            throw new CreddaError(401, revocationMessage(frame.data), path, {
              code: 'UNAUTHENTICATED',
            });
          }
          const sequence = Number(frame.id);
          if (Number.isInteger(sequence) && sequence > since) since = sequence;
          yield JSON.parse(frame.data) as T;
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }

    if (options.reconnect !== true) return;
    if (options.signal?.aborted === true) return;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

/** The server's own wording when it can be read; never a substitute of ours. */
function revocationMessage(data: string): string {
  try {
    const parsed = JSON.parse(data) as { reason?: unknown };
    if (typeof parsed.reason === 'string') return parsed.reason;
  } catch {
    /* fall through */
  }
  return 'the API key for this stream was revoked';
}
