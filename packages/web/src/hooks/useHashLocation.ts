/**
 * A minimal hash-based router.
 *
 * react-router was removed from the dependency tree for a security advisory,
 * and the app's navigation needs are small enough that a hand-rolled listener
 * on `hashchange` is simpler and easier to audit than a routing library.
 */

import { useEffect, useState } from 'react';

export interface HashLocation {
  /** Path segment, e.g. `/files`. Always starts with `/`. */
  path: string;
  params: URLSearchParams;
}

function parseHash(): HashLocation {
  const raw = window.location.hash.replace(/^#/, '') || '/';
  const [path = '/', search = ''] = raw.split('?');
  return { path: path.length > 0 ? path : '/', params: new URLSearchParams(search) };
}

/** Sets the hash location, optionally with query parameters. */
export function navigate(path: string, params?: Record<string, string>): void {
  const query = params ? new URLSearchParams(params).toString() : '';
  window.location.hash = query ? `${path}?${query}` : path;
}

export function useHashLocation(): HashLocation {
  const [location, setLocation] = useState<HashLocation>(parseHash);

  useEffect(() => {
    const handler = (): void => setLocation(parseHash());
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);

  return location;
}

/** Splits a `/files/:id`-shaped path into its base and an optional trailing id. */
export function splitFirstSegment(path: string): { base: string; rest?: string } {
  const trimmed = path.replace(/^\/+/, '');
  const slash = trimmed.indexOf('/');
  if (slash === -1) return { base: `/${trimmed}` };
  return {
    base: `/${trimmed.slice(0, slash)}`,
    rest: decodeURIComponent(trimmed.slice(slash + 1)),
  };
}

/** Convenience hook returning the navigate function (a stable module-level reference). */
export function useNavigate(): (path: string, params?: Record<string, string>) => void {
  return navigate;
}
