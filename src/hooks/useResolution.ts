import { useCallback, useEffect, useState } from 'react';
import { useCreddaClient } from '../components/CreddaProvider.js';
import type { Resolution } from '../lib/types.js';

export interface UseResolutionResult {
  /**
   * The newest resolution record for the investigation, or null.
   *
   * **Null is an answer.** It means the investigation exists and has produced no
   * record yet — not that the id was wrong, which arrives as an `error`. Render
   * the two differently.
   */
  resolution: Resolution | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * The latest resolution record for one investigation: what the run established
 * about a reported failure, and — in `confidence.notEstablished` — what it did
 * not. Render the gaps; they are half the record.
 */
export function useResolution(investigationId: string | null | undefined): UseResolutionResult {
  const client = useCreddaClient();
  const [resolution, setResolution] = useState<Resolution | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!investigationId) {
      setResolution(null);
      setError(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setError(null);

    client
      .latestResolution(investigationId, { signal: controller.signal })
      .then((body) => {
        if (!cancelled) setResolution(body.resolution);
      })
      .catch((err: unknown) => {
        if (cancelled || controller.signal.aborted) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [client, investigationId, nonce]);

  return { resolution, loading, error, refetch };
}
