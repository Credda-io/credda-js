import { useState, useEffect } from 'react';
import { ScorePayload } from '../lib/client.js';
import { useCreddaClient } from '../components/CreddaProvider.js';

export interface UseScoreResult {
  data: ScorePayload | null;
  loading: boolean;
  error: Error | null;
}

/**
 * Fetch the latest computed score for a user.
 *
 * Requires a platform API key (`crd_live_…`). This performs an authenticated
 * request, so use it in a SERVER-SIDE / trusted context only — never ship a
 * platform key to the browser. For public, in-browser trust badges use
 * `useTrustToken` (a share token) instead.
 */
export function useScore(userId: string | null | undefined, apiKey: string | null | undefined): UseScoreResult {
  const client = useCreddaClient();
  const [data, setData] = useState<ScorePayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!userId || !apiKey) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    client
      .getScore(userId, apiKey)
      .then((score) => {
        if (!cancelled) setData(score);
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
  }, [userId, apiKey, client]);

  return { data, loading, error };
}
