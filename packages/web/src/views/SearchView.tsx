/**
 * Full-text search across every discovered file, with debounced querying and
 * provider/kind/scope filter chips.
 */

import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { getScan, search } from '../api/client.js';
import { EmptyState, ErrorState, LoadingState } from '../components/StatusStates.js';
import { useAsync } from '../hooks/useAsync.js';
import { useDebouncedValue } from '../hooks/useDebouncedValue.js';
import { SCOPE_LABELS, SCOPE_ORDER } from '../lib/scope.js';
import type { ConfigScope, FileKind, SearchHit } from '../api/types.js';

const KIND_OPTIONS: FileKind[] = [
  'settings',
  'mcp',
  'instructions',
  'agent',
  'skill',
  'prompt',
  'command',
  'chatmode',
  'permissions',
  'ignore',
  'memory',
  'extension',
  'catalog',
  'credential',
  'unknown',
];

function toggle<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

/**
 * Wraps each case-insensitive occurrence of `query` in a `<mark>`.
 *
 * Built by slicing rather than by regex replacement so that a query containing
 * regex metacharacters (common in these files — `.`, `*`, `$`, `{`) can never
 * be interpreted as a pattern, and so the surrounding text stays plain text
 * rather than being reinterpreted as markup.
 */
function highlight(text: string, query: string): ReactElement {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return <>{text}</>;

  const parts: ReactElement[] = [];
  const haystack = text.toLowerCase();
  let cursor = 0;

  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, cursor)) {
    if (at > cursor) parts.push(<span key={cursor}>{text.slice(cursor, at)}</span>);
    parts.push(<mark key={`m${String(at)}`}>{text.slice(at, at + needle.length)}</mark>);
    cursor = at + needle.length;
  }

  if (cursor === 0) return <>{text}</>;
  if (cursor < text.length) parts.push(<span key={cursor}>{text.slice(cursor)}</span>);
  return <>{parts}</>;
}

export function SearchView({ initialQuery }: { initialQuery: string }): ReactElement {
  const [query, setQuery] = useState(initialQuery);
  const [providers, setProviders] = useState<Set<string>>(new Set());
  const [kinds, setKinds] = useState<Set<FileKind>>(new Set());
  const [scopes, setScopes] = useState<Set<ConfigScope>>(new Set());
  const debouncedQuery = useDebouncedValue(query.trim(), 300);

  const scan = useAsync(getScan, []);
  const availableProviders = useMemo(() => {
    const map = new Map<string, string>();
    for (const group of scan.data?.tree ?? []) map.set(group.providerId, group.providerName);
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [scan.data]);

  const results = useAsync(async () => {
    if (debouncedQuery.length === 0) {
      return { query: '', hits: [] as SearchHit[], truncated: false, filesSearched: 0 };
    }
    return search({
      q: debouncedQuery,
      provider: [...providers],
      kind: [...kinds],
      scope: [...scopes],
    });
  }, [debouncedQuery, providers, kinds, scopes]);

  const grouped = useMemo(() => {
    const map = new Map<string, { displayPath: string; providerName: string; hits: SearchHit[] }>();
    for (const hit of results.data?.hits ?? []) {
      const existing = map.get(hit.fileId);
      if (existing) existing.hits.push(hit);
      else
        map.set(hit.fileId, {
          displayPath: hit.displayPath,
          providerName: hit.providerName,
          hits: [hit],
        });
    }
    return [...map.entries()];
  }, [results.data]);

  return (
    <div className="view view-search">
      <h2>Search</h2>
      <div className="search-box">
        <label htmlFor="search-input">Search text</label>
        <input
          id="search-input"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search across every configuration file…"
          autoComplete="off"
        />
      </div>

      <fieldset className="filter-group">
        <legend>Scope</legend>
        <div className="chip-toggle-list">
          {SCOPE_ORDER.map((scope) => (
            <ChipToggle
              key={scope}
              label={SCOPE_LABELS[scope]}
              pressed={scopes.has(scope)}
              onToggle={() => setScopes((prev) => toggle(prev, scope))}
            />
          ))}
        </div>
      </fieldset>

      <fieldset className="filter-group">
        <legend>Kind</legend>
        <div className="chip-toggle-list">
          {KIND_OPTIONS.map((kind) => (
            <ChipToggle
              key={kind}
              label={kind}
              pressed={kinds.has(kind)}
              onToggle={() => setKinds((prev) => toggle(prev, kind))}
            />
          ))}
        </div>
      </fieldset>

      {availableProviders.length > 0 ? (
        <fieldset className="filter-group">
          <legend>Provider</legend>
          <div className="chip-toggle-list">
            {availableProviders.map(([id, name]) => (
              <ChipToggle
                key={id}
                label={name}
                pressed={providers.has(id)}
                onToggle={() => setProviders((prev) => toggle(prev, id))}
              />
            ))}
          </div>
        </fieldset>
      ) : null}

      <div aria-live="polite" className="search-results">
        {query.trim().length === 0 ? (
          <EmptyState
            title="Type to search."
            detail="Results appear across every discovered file."
          />
        ) : results.loading ? (
          <LoadingState label="Searching…" />
        ) : results.error ? (
          <ErrorState
            message={results.error}
            {...(results.retryable ? { onRetry: results.reload } : {})}
          />
        ) : !results.data || results.data.hits.length === 0 ? (
          <EmptyState
            title="No matches found."
            detail="Try a different query or clear some filters."
          />
        ) : (
          <>
            <p className="muted">
              {results.data.filesSearched} file(s) searched.
              {results.data.truncated
                ? ' Results were truncated; refine your query for a complete list.'
                : ''}
            </p>
            <ul className="search-result-list">
              {grouped.map(([fileId, group]) => (
                <li key={fileId} className="search-result-file">
                  <h3>
                    <a href={`#/files/${encodeURIComponent(fileId)}`}>{group.displayPath}</a>{' '}
                    <span className="chip">{group.providerName}</span>
                  </h3>
                  <ol className="search-hit-list">
                    {group.hits.map((hit) => (
                      <li key={`${hit.fileId}-${hit.line}`}>
                        <a href={`#/files/${encodeURIComponent(hit.fileId)}`}>
                          <span className="search-hit-line">Line {hit.line}</span>
                          <code className="search-hit-text">
                            {highlight(hit.text, debouncedQuery)}
                          </code>
                        </a>
                      </li>
                    ))}
                  </ol>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

function ChipToggle({
  label,
  pressed,
  onToggle,
}: {
  label: string;
  pressed: boolean;
  onToggle: () => void;
}): ReactElement {
  return (
    <button type="button" className="chip chip-toggle" aria-pressed={pressed} onClick={onToggle}>
      {pressed ? <span aria-hidden="true">&#10003; </span> : null}
      {label}
    </button>
  );
}
