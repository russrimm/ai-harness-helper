/**
 * What the harness costs on every request.
 *
 * The rest of the app answers "what do I have?". This answers "what am I
 * paying for it?" — the question that actually drives streamlining, because
 * nobody deletes an instruction file they think is free.
 *
 * The split matters more than the totals. A 40 KB skill nobody has invoked
 * this month costs almost nothing; a 12 KB always-on instruction file costs
 * that much on every turn forever. Presenting one number for both would tell
 * the user to delete the wrong thing.
 */

import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { getContextBudget } from '../api/client.js';
import { Badge, scopeVariant } from '../components/Badge.js';
import { EmptyState, ErrorState, LoadingState } from '../components/StatusStates.js';
import { StatCard } from '../components/StatCard.js';
import { useAsync } from '../hooks/useAsync.js';
import { SCOPE_LABELS } from '../lib/scope.js';
import type { BudgetContributor, LoadTiming, ProviderBudget } from '../api/types.js';

const TIMING_LABELS: Record<LoadTiming, string> = {
  always: 'Every request',
  conditional: 'When the glob matches',
  'on-demand': 'When selected',
};

const TIMING_HINTS: Record<LoadTiming, string> = {
  always: 'Read before your question, on every single turn.',
  conditional: 'Attached only when the work touches files its applyTo glob matches.',
  'on-demand': 'Only the name and description are always present; the body loads on selection.',
};

const TIMINGS: readonly LoadTiming[] = ['always', 'conditional', 'on-demand'];

export function BudgetView(): ReactElement {
  const state = useAsync(getContextBudget, []);
  const [expanded, setExpanded] = useState<string | undefined>(undefined);

  const providers = state.data?.providers ?? [];
  const worstFirst = useMemo(
    () => [...providers].sort((a, b) => b.alwaysBytes - a.alwaysBytes),
    [providers],
  );

  if (state.loading) return <LoadingState label="Measuring what loads on every request…" />;
  if (state.error) {
    return (
      <ErrorState message={state.error} {...(state.retryable ? { onRetry: state.reload } : {})} />
    );
  }
  if (!state.data) return <EmptyState title="No budget available." />;

  const { totals, bytesPerToken, heaviest } = state.data;

  return (
    <div className="view view-budget">
      <div className="view-header">
        <h2>Context budget</h2>
      </div>

      <p className="muted">
        Roughly <strong>{totals.alwaysTokens.toLocaleString()}</strong> estimated tokens (
        {formatBytes(totals.alwaysBytes)}) are read before your question on every request, across
        every tool. Token counts are an approximation at {bytesPerToken} bytes each; the real number
        depends on a tokenizer this tool deliberately does not bundle. MCP servers publish their
        tool schemas at runtime, so their context cost cannot be measured without launching them and
        is shown as a server count instead.
      </p>

      <div className="stat-grid">
        <StatCard
          label="Always loaded"
          value={formatBytes(totals.alwaysBytes)}
          hint={`~${totals.alwaysTokens.toLocaleString()} tokens, every turn`}
          {...(totals.alwaysBytes > 32 * 1024 ? { tone: 'warning' as const } : {})}
        />
        <StatCard
          label="Conditional"
          value={formatBytes(totals.conditionalBytes)}
          hint="Scoped by an applyTo glob"
        />
        <StatCard
          label="On demand"
          value={formatBytes(totals.onDemandBytes)}
          hint="Capability bodies, loaded when selected"
        />
        <StatCard
          label="Contributors"
          value={totals.contributorCount}
          hint="Files that cost context"
        />
      </div>

      {heaviest ? (
        <p className="notice notice-info">
          <strong>Heaviest always-on file:</strong>{' '}
          <a href={`#/files/${encodeURIComponent(heaviest.fileId)}`}>{heaviest.displayPath}</a> at{' '}
          {formatBytes(heaviest.alwaysBytes)} — about{' '}
          {Math.round((heaviest.alwaysBytes / Math.max(1, totals.alwaysBytes)) * 100)}% of
          everything loaded on every request.
        </p>
      ) : null}

      {worstFirst.length === 0 ? (
        <EmptyState
          title="Nothing loads on every request."
          detail="No instruction files, memories, or capabilities were found."
        />
      ) : (
        <ul className="budget-list">
          {worstFirst.map((provider) => (
            <ProviderCard
              key={provider.providerId}
              provider={provider}
              totalAlways={totals.alwaysBytes}
              expanded={expanded === provider.providerId}
              onToggle={() =>
                setExpanded((current) =>
                  current === provider.providerId ? undefined : provider.providerId,
                )
              }
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ProviderCard({
  provider,
  totalAlways,
  expanded,
  onToggle,
}: {
  provider: ProviderBudget;
  totalAlways: number;
  expanded: boolean;
  onToggle: () => void;
}): ReactElement {
  const share = totalAlways > 0 ? (provider.alwaysBytes / totalAlways) * 100 : 0;
  const contributors = expanded
    ? provider.contributors
    : provider.contributors.filter((c) => c.alwaysBytes > 0).slice(0, 5);

  return (
    <li className="budget-card">
      <div className="budget-card-header">
        <h3>{provider.providerName}</h3>
        <span className="muted small">
          {formatBytes(provider.alwaysBytes)} always
          {' \u00B7 '}~{provider.alwaysTokens.toLocaleString()} tokens
          {provider.mcpServerCount > 0
            ? ` \u00B7 ${provider.mcpServerCount} MCP server${provider.mcpServerCount === 1 ? '' : 's'} (unmeasured)`
            : ''}
        </span>
      </div>

      {/* A share bar rather than a chart: one number compared to one total. */}
      <div
        className="budget-bar"
        role="img"
        aria-label={`${provider.providerName} accounts for ${Math.round(share)} percent of always-loaded context`}
      >
        <div className="budget-bar-fill" style={{ width: `${Math.max(1, Math.round(share))}%` }} />
      </div>

      <dl className="budget-split">
        {TIMINGS.map((timing) => {
          const bytes =
            timing === 'always'
              ? provider.alwaysBytes
              : timing === 'conditional'
                ? provider.conditionalBytes
                : provider.onDemandBytes;
          return (
            <div key={timing}>
              <dt title={TIMING_HINTS[timing]}>{TIMING_LABELS[timing]}</dt>
              <dd>{formatBytes(bytes)}</dd>
            </div>
          );
        })}
      </dl>

      {contributors.length > 0 ? (
        <table className="budget-table">
          <caption className="visually-hidden">
            Files contributing to {provider.providerName}&apos;s context cost
          </caption>
          <thead>
            <tr>
              <th scope="col">File</th>
              <th scope="col">Scope</th>
              <th scope="col">When</th>
              <th scope="col">Every request</th>
              <th scope="col">On top</th>
            </tr>
          </thead>
          <tbody>
            {contributors.map((contributor) => (
              <ContributorRow key={contributor.fileId} contributor={contributor} />
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted small">Nothing here loads on every request.</p>
      )}

      {provider.contributors.length > contributors.length || expanded ? (
        <button type="button" className="link-button" onClick={onToggle}>
          {expanded
            ? 'Show only what loads every time'
            : `Show all ${provider.contributors.length} contributors`}
        </button>
      ) : null}
    </li>
  );
}

function ContributorRow({ contributor }: { contributor: BudgetContributor }): ReactElement {
  return (
    <tr>
      <th scope="row">
        <a href={`#/files/${encodeURIComponent(contributor.fileId)}`}>{contributor.label}</a>
        <span className="muted small budget-path">{contributor.displayPath}</span>
      </th>
      <td>
        <Badge variant={scopeVariant(contributor.scope)}>{SCOPE_LABELS[contributor.scope]}</Badge>
      </td>
      <td>
        {TIMING_LABELS[contributor.timing]}
        {contributor.appliesTo ? (
          <>
            {' '}
            <code className="small">{contributor.appliesTo}</code>
          </>
        ) : null}
      </td>
      <td>{contributor.alwaysBytes > 0 ? formatBytes(contributor.alwaysBytes) : '—'}</td>
      <td>{contributor.situationalBytes > 0 ? formatBytes(contributor.situationalBytes) : '—'}</td>
    </tr>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) return `${kilobytes.toFixed(1)} KB`;
  return `${(kilobytes / 1024).toFixed(1)} MB`;
}
