/**
 * Generic async-fetch state, used by every view to render loading / error /
 * data consistently without repeating the same three `useState` calls.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client.js';

export interface AsyncState<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
  reload: () => void;
}

export function useAsync<T>(load: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);

    loadRef
      .current()
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(describeError(caught));
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

  return { data, error, loading, reload };
}

export function describeError(error: unknown): string {
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
