import { useCallback, useEffect, useState } from 'react';
import { useCreddaClient } from '../components/CreddaProvider.js';
import type { InvestigationDetail } from '../lib/types.js';

export interface UseInvestigationResult {
  data: InvestigationDetail | null;
  loading: boolean;
  error: Error | null;
  /** Re-reads the detail. The engine advances the run; nothing here polls for it. */
  refetch: () => void;
}

/**
 * One investigation and everything hanging off it: the run, its hypotheses, its
 * patches, its verification runs, and the counts.
 *
 * This is a single read, not a subscription. To watch a run as it happens,
 * pair it with {@link useInvestigationEvents}, which is the live half.
 */
export function useInvestigation(id: string | null | undefined): UseInvestigationResult {
  const client = useCreddaClient();
  const [data, setData] = useState<InvestigationDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!id) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setError(null);

    client
      .getInvestigation(id, { signal: controller.signal })
      .then((detail) => {
        if (!cancelled) setData(detail);
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
  }, [client, id, nonce]);

  return { data, loading, error, refetch };
}
