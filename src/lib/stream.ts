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
 * Three server behaviours a consumer has to know about, each announced by a
 * named frame before the close rather than left to a silent disconnect:
 *  - When the run reaches a terminal state the server sends `complete` with
 *    `{ state }`. The generator returns there and does not reconnect: the run
 *    is over, and reopening would replay the backlog and the same frame.
 *  - A stream that has carried no event for five minutes is dropped, with an
 *    `idle` frame saying so. The run has NOT finished; that is not an error,
 *    and `reconnect` exists for it.
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
  /**
   * Called with the terminal state once, when the server says the run has
   * finished. The generator then returns, `reconnect` or not.
   *
   * It is a callback rather than a final yielded value because the generator's
   * element type is the event, and a caller looping over it must not have to
   * discriminate a state string out of it. A caller that does not want the
   * state can leave this off and read the return as "the run is over".
   */
  onComplete?: ((state: string) => void) | undefined;
}

/**
 * Yields events off one SSE route until the run finishes, the stream ends, or
 * -- with `reconnect` -- the link is reopened and the run carries on. The
 * `sequence` of each event is taken from the SSE `id`, which is what the server
 * frames it with, so a caller can persist a cursor.
 *
 * Three of the server's frames are not events and are never yielded as one:
 * `complete` ends the generator, `idle` ends the pass the server dropped, and
 * `unauthenticated` throws. Only `complete` is final under `reconnect`.
 */
export async function* streamSse<T>(
  transport: Transport,
  path: string,
  options: StreamOptions = {},
): AsyncGenerator<T, void, undefined> {
  let since = options.since ?? 0;
  const delay = options.reconnectDelayMs ?? 1_000;
  // Set by a `complete` frame, which is the run's own answer and the one close
  // there is nothing left to reconnect for.
  let finished = false;

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
          // The run reached a terminal state. Its payload is `{ state }`, not
          // an event, so yielding it would hand the caller an object with no
          // `sequence` and no `type` typed as one; and under `reconnect` a
          // consumer that did not recognise this frame reopened the stream
          // against a finished run, was sent the same backlog and the same
          // `complete`, and went round again for as long as it was left
          // running. `onComplete` is where the terminal state goes instead.
          if (frame.event === 'complete') {
            finished = true;
            options.onComplete?.(completedState(frame.data));
            return;
          }
          // The server dropped a quiet stream. The run has NOT finished, so
          // this ends one pass and `reconnect` resumes from the same cursor.
          if (frame.event === 'idle') break;
          const sequence = Number(frame.id);
          if (Number.isInteger(sequence) && sequence > since) since = sequence;
          yield JSON.parse(frame.data) as T;
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }

    if (finished) return;
    if (options.reconnect !== true) return;
    if (options.signal?.aborted === true) return;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

/** The terminal state off a `complete` frame, or '' if the frame carried none. */
function completedState(data: string): string {
  try {
    const parsed = JSON.parse(data) as { state?: unknown };
    if (typeof parsed.state === 'string') return parsed.state;
  } catch {
    /* fall through */
  }
  return '';
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
