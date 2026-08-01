/**
 * Generic async-fetch state, used by every view to render loading / error /
 * data consistently without repeating the same three `useState` calls.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, NetworkError } from '../api/client.js';

export interface AsyncState<T> {
  data: T | undefined;
  error: string | undefined;
  /** False when retrying in this tab cannot possibly succeed. */
  retryable: boolean;
  loading: boolean;
  reload: () => void;
}

export function useAsync<T>(load: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [retryable, setRetryable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    setRetryable(true);

    loadRef
      .current()
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setError(describeError(caught));
        setRetryable(isRetryable(caught));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // `deps` is caller-supplied and intentionally drives this effect in full.
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((value) => value + 1), []);

  return { data, error, retryable, loading, reload };
}

/**
 * Whether offering a retry is honest.
 *
 * Both cases below are unrecoverable from inside an already-loaded tab, and a
 * button that cannot work is worse than no button: it invites the user to
 * click repeatedly instead of reading the instruction that would fix things.
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof NetworkError) return false;
  if (error instanceof ApiError && error.status === 401) return false;
  return true;
}

export function describeError(error: unknown): string {
  // The server is gone, so this tab is a snapshot of a session that ended.
  // Restarting mints a new token, which is why reloading here is not enough.
  if (error instanceof NetworkError) {
    return (
      'The ai-harness-helper server is no longer running, so this page has ' +
      'nothing to talk to. Start it again with `ai-harness-helper` in your ' +
      'terminal and open the fresh link it prints — the token changes every run.'
    );
  }

  // A 401 here almost always means the page was reloaded in a tab that never
  // carried the token, or the CLI was restarted and issued a new one. Neither
  // is fixable by retrying, so the message says what actually works.
  if (error instanceof ApiError && error.status === 401) {
    return (
      'This tab is not authorized. Open the link printed by ' +
      '`ai-harness-helper` in your terminal — it carries a one-time token that ' +
      'changes every run.'
    );
  }
  return error instanceof Error ? error.message : String(error);
}
