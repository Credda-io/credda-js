import { useState, useEffect } from 'react';
import { TrustPayload } from '../lib/client.js';
import { useCreddaClient } from '../components/CreddaProvider.js';

export interface UseTrustTokenResult {
  data: TrustPayload | null;
  loading: boolean;
  error: Error | null;
}

/**
 * Resolve a short-lived trust token into a public TrustPayload.
 * Suitable for rendering trust badges inside React apps.
 */
export function useTrustToken(token: string | null | undefined): UseTrustTokenResult {
  const client = useCreddaClient();
  const [data, setData] = useState<TrustPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!token) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    client
      .resolveToken(token)
      .then((payload) => {
        if (!cancelled) setData(payload);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [token, client]);

  return { data, loading, error };
}
