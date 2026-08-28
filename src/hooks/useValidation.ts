import { useCallback, useEffect, useState } from 'react';
import { useCreddaClient } from '../components/CreddaProvider.js';
import type { ValidationDetail } from '../lib/types.js';

export interface UseValidationResult {
  data: ValidationDetail | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * One validation run: the run itself, the environment it was given, and the
 * counts.
 *
 * `checkCount` is on the detail rather than a page away for a reason worth
 * carrying into any UI built on this: a completed run with zero checks is the
 * false success this product exists to prevent, and it must be visible without
 * a second request. `environment.status` is the other one — a run that ended
 * BLOCKED must not be rendered as a failure of the change.
 */
export function useValidation(id: string | null | undefined): UseValidationResult {
  const client = useCreddaClient();
  const [data, setData] = useState<ValidationDetail | null>(null);
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
      .getValidation(id, { signal: controller.signal })
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
