import type { ConfigScope } from '../api/types.js';

/** Precedence order used consistently across views: project overrides user overrides managed. */
export const SCOPE_ORDER: readonly ConfigScope[] = ['project', 'user', 'managed'];

export const SCOPE_LABELS: Record<ConfigScope, string> = {
  project: 'Project',
  user: 'User',
  managed: 'Managed',
};

export function compareScope(a: ConfigScope, b: ConfigScope): number {
  return SCOPE_ORDER.indexOf(a) - SCOPE_ORDER.indexOf(b);
}
