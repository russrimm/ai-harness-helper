/**
 * Effective configuration — which declaration each tool actually loads.
 *
 * Every other view answers "where is this declared?". This one answers the
 * question you need before deleting anything: of the three files declaring
 * `github`, which one runs, and are the other two identical copies or a
 * different server you are about to lose?
 *
 * Rows are ordered so contested entries lead. An entry where the shadowed copy
 * matches the winner is housekeeping; an entry where it does not is a file you
 * are reading that has no effect on what the tool does.
 */

import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { getEffective } from '../api/client.js';
import { Badge, scopeVariant, type BadgeVariant } from '../components/Badge.js';
import { EmptyState, ErrorState, LoadingState } from '../components/StatusStates.js';
import { useAsync } from '../hooks/useAsync.js';
import { SCOPE_LABELS } from '../lib/scope.js';
import type {
  DeclarationStatus,
  EffectiveEntry,
  EffectiveKind,
  EffectiveProvider,
} from '../api/types.js';

const KIND_LABELS: Record<EffectiveKind, string> = {
  mcp: 'MCP server',
  capability: 'Capability',
  instruction: 'Instruction',
  guardrail: 'Guardrail',
};

const STATUS_LABELS: Record<DeclarationStatus, string> = {
  active: 'In effect',
  shadowed: 'Never loaded',
  merged: 'Layered',
  disabled: 'Disabled',
};

const STATUS_VARIANTS: Record<DeclarationStatus, BadgeVariant> = {
  active: 'ok',
  shadowed: 'warning',
  merged: 'info',
  disabled: 'disabled',
};

type Filter = 'contested' | 'shadowed' | 'all';

export function EffectiveView(): ReactElement {
  const state = useAsync(getEffective, []);
  const [filter, setFilter] = useState<Filter>('contested');
  const [kind, setKind] = useState<EffectiveKind | 'all'>('all');

  const data = state.data;
  const providers = useMemo(
    () => filterProviders(data?.providers ?? [], filter, kind),
    [data, filter, kind],
  );

  if (state.loading) return <LoadingState label="Resolving effective configuration…" />;
  if (state.error) {
    return (
      <ErrorState message={state.error} {...(state.retryable ? { onRetry: state.reload } : {})} />
    );
  }
  if (!data) return <EmptyState title="No data available." />;

  return (
    <div className="view view-effective">
      <div className="view-header">
        <h2>Effective configuration</h2>
      </div>
      <p className="muted">
        {data.totalEntries} resolved entries across {data.providers.length} tools.{' '}
        {data.totalShadowed} declarations are never loaded, and {data.totalContested} of those say
        something different from the declaration that wins — those are the ones worth opening.
        Precedence is resolved per tool, because two tools declaring the same name is not a
        conflict.
      </p>

      <div className="toolbar">
        <label htmlFor="effective-filter">Show</label>
        <select
          id="effective-filter"
          value={filter}
          onChange={(event) => setFilter(event.target.value as Filter)}
        >
          <option value="contested">Contested only</option>
          <option value="shadowed">Anything shadowed</option>
          <option value="all">Everything</option>
        </select>
        <label htmlFor="effective-kind">Kind</label>
        <select
          id="effective-kind"
          value={kind}
          onChange={(event) => setKind(event.target.value as EffectiveKind | 'all')}
        >
          <option value="all">All kinds</option>
          <option value="mcp">MCP servers</option>
          <option value="capability">Capabilities</option>
          <option value="instruction">Instructions</option>
          <option value="guardrail">Guardrails</option>
        </select>
      </div>

      {providers.length === 0 ? (
        <EmptyState
          title={
            filter === 'contested'
              ? 'Nothing is contested.'
              : filter === 'shadowed'
                ? 'Nothing is shadowed.'
                : 'No entries match.'
          }
          {...(filter === 'contested'
            ? {
                detail:
                  'Every declaration a tool would skip is an identical copy of the one it loads.',
              }
            : {})}
        />
      ) : (
        providers.map((provider) => (
          <ProviderSection key={provider.providerId} provider={provider} />
        ))
      )}
    </div>
  );
}

function filterProviders(
  providers: readonly EffectiveProvider[],
  filter: Filter,
  kind: EffectiveKind | 'all',
): EffectiveProvider[] {
  const out: EffectiveProvider[] = [];
  for (const provider of providers) {
    const entries = provider.entries.filter((entry) => {
      if (kind !== 'all' && entry.kind !== kind) return false;
      if (filter === 'contested') return entry.contested;
      if (filter === 'shadowed') return entry.shadowedCount > 0;
      return true;
    });
    if (entries.length > 0) out.push({ ...provider, entries });
  }
  return out;
}

function ProviderSection({ provider }: { provider: EffectiveProvider }): ReactElement {
  const headingId = `effective-${provider.providerId}`;
  return (
    <section aria-labelledby={headingId} className="effective-provider">
      <h3 id={headingId}>
        {provider.providerName} <span className="muted">({provider.entries.length})</span>
      </h3>
      <ul className="effective-list">
        {provider.entries.map((entry) => (
          <EntryCard key={entry.key} entry={entry} />
        ))}
      </ul>
    </section>
  );
}

function EntryCard({ entry }: { entry: EffectiveEntry }): ReactElement {
  return (
    <li className={entry.contested ? 'effective-card is-conflict' : 'effective-card'}>
      <div className="effective-card-header">
        <span className="chip">{KIND_LABELS[entry.kind]}</span>
        <strong>{entry.name}</strong>
        <Badge variant={entry.strategy === 'merge' ? 'info' : 'neutral'}>
          {entry.strategy === 'merge' ? 'Layered together' : 'Nearest wins'}
        </Badge>
        {entry.contested ? <Badge variant="conflict">Contested</Badge> : null}
      </div>
      <ol className="effective-declarations">
        {entry.declarations.map((declaration) => (
          <li key={declaration.fileId} className={`effective-declaration is-${declaration.status}`}>
            <div className="effective-declaration-header">
              <Badge variant={STATUS_VARIANTS[declaration.status]}>
                {STATUS_LABELS[declaration.status]}
              </Badge>
              <Badge variant={scopeVariant(declaration.scope)}>
                {SCOPE_LABELS[declaration.scope]}
              </Badge>
              <a href={`#/files/${encodeURIComponent(declaration.fileId)}`}>
                {declaration.displayPath}
              </a>
            </div>
            <p className="muted small">{declaration.reason}</p>
          </li>
        ))}
      </ol>
    </li>
  );
}
