import { useEffect, useRef, useState } from 'react';

/** The minimum an event needs for a subscription to keep a cursor. */
export interface SequencedEvent {
  sequence: number;
}

export interface UseEventStreamOptions {
  /** Resume after this sequence. Default 0: the whole timeline replays. */
  since?: number;
  /** Reopen the stream when the server closes it. Default true — see below. */
  reconnect?: boolean;
}

export interface UseEventStreamResult<T> {
  /** Every event received, in sequence order. Appended to as they arrive. */
  events: T[];
  /** The sequence of the newest event seen, or the `since` it started from. */
  latestSequence: number;
  /** True once the stream is open and has not ended. */
  streaming: boolean;
  error: Error | null;
}

/**
 * The subscription behind {@link import('./useInvestigationEvents.js').useInvestigationEvents}
 * and {@link import('./useValidationEvents.js').useValidationEvents}.
 *
 * Internal, and not exported from the package: an investigation timeline and a
 * validation timeline are different event types on different routes, and a
 * public "stream anything" hook would invite a caller to point it at a path
 * this API does not serve.
 *
 * `reconnect` defaults to true because a mounted component is watching a run
 * rather than taking one pass over it, and the server drops any stream that has
 * carried nothing for five minutes — which a long, quiet run reliably does.
 * Resumption is by sequence, so nothing is missed across a reconnect. A revoked
 * key ends the stream for good and arrives as `error`.
 */
export function useEventStream<T extends SequencedEvent>(
  key: string | null | undefined,
  open: (since: number, signal: AbortSignal, reconnect: boolean) => AsyncGenerator<T>,
  options: UseEventStreamOptions = {},
): UseEventStreamResult<T> {
  const { since = 0, reconnect = true } = options;
  const [events, setEvents] = useState<T[]>([]);
  const [latestSequence, setLatestSequence] = useState(since);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  // Held in a ref so a re-render mid-stream cannot resubscribe from the start.
  const seenRef = useRef(since);
  // `open` is a closure a caller rebuilds every render; re-subscribing on its
  // identity would drop and reopen the stream on every keystroke elsewhere in
  // the tree. The effect below depends on `key` and the options instead.
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    if (!key) {
      setStreaming(false);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    seenRef.current = since;
    setEvents([]);
    setLatestSequence(since);
    setError(null);
    setStreaming(true);

    void (async () => {
      try {
        for await (const event of openRef.current(seenRef.current, controller.signal, reconnect)) {
          if (cancelled) break;
          seenRef.current = Math.max(seenRef.current, event.sequence);
          setEvents((prev) => [...prev, event]);
          setLatestSequence(seenRef.current);
        }
      } catch (err: unknown) {
        if (cancelled || controller.signal.aborted) return;
        if (err instanceof Error && err.name === 'AbortError') return;
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        if (!cancelled) setStreaming(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [key, since, reconnect]);

  return { events, latestSequence, streaming, error };
}
