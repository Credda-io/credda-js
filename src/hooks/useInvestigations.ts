import { useCallback, useEffect, useState } from 'react';
import { useCreddaClient } from '../components/CreddaProvider.js';
import type { ListInvestigationsQuery } from '../lib/client.js';
import type { InvestigationSummary } from '../lib/types.js';

export interface UseInvestigationsResult {
  investigations: InvestigationSummary[];
  /** The size of the whole filtered set. A page is not the total. */
  total: number;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * A page of investigations, newest first, optionally filtered by state.
 *
 * The query is read field by field rather than by identity so that an inline
 * object literal — which is what a caller writes — does not refetch on every
 * render.
 */
export function useInvestigations(
  query: Omit<ListInvestigationsQuery, 'signal'> = {},
): UseInvestigationsResult {
  const client = useCreddaClient();
  const { state, limit, offset } = query;
  const [investigations, setInvestigations] = useState<InvestigationSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setError(null);

    client
      .listInvestigations({ state, limit, offset, signal: controller.signal })
      .then((page) => {
        if (cancelled) return;
        setInvestigations(page.investigations);
        setTotal(page.total);
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
  }, [client, state, limit, offset, nonce]);

  return { investigations, total, loading, error, refetch };
}
