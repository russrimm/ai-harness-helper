/**
 * Model pins across the whole harness, and which of them point at a model the
 * vendor has retired or scheduled for shutdown.
 *
 * Model ids are the one thing in a config that goes stale on someone else's
 * calendar. An agent front matter written a year ago is still valid YAML and
 * still parses cleanly — it just fails at request time. This view is the only
 * place that fact is visible without opening every file.
 *
 * Unknown ids are shown as unknown rather than as a problem. Vendors ship
 * models faster than any bundled table can track, so guessing would flag a
 * brand-new model as dead, which is the one mistake that would make the whole
 * view untrustworthy.
 */

import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { getInventory } from '../api/client.js';
import { Badge, scopeVariant, type BadgeVariant } from '../components/Badge.js';
import { EmptyState, ErrorState, LoadingState } from '../components/StatusStates.js';
import { useAsync } from '../hooks/useAsync.js';
import { SCOPE_LABELS } from '../lib/scope.js';
import type { ModelStatus, ModelUsageEntry } from '../api/types.js';

const STATUS_LABELS: Record<ModelStatus, string> = {
  retired: 'Retired',
  deprecated: 'Shutdown announced',
  active: 'Supported',
  unknown: 'Not in the bundled table',
};

const STATUS_VARIANTS: Record<ModelStatus, BadgeVariant> = {
  retired: 'error',
  deprecated: 'warning',
  active: 'ok',
  unknown: 'neutral',
};

const STATUS_ORDER: ModelStatus[] = ['retired', 'deprecated', 'unknown', 'active'];

type Filter = 'outdated' | 'all';

interface ModelGroup {
  id: string;
  status: ModelStatus;
  entries: ModelUsageEntry[];
}

export function ModelsView(): ReactElement {
  const state = useAsync(getInventory, []);
  const [filter, setFilter] = useState<Filter>('outdated');

  const usage = state.data?.modelUsage ?? [];
  const groups = useMemo(() => groupModels(usage, filter), [usage, filter]);

  if (state.loading) return <LoadingState label="Loading model usage…" />;
  if (state.error) {
    return (
      <ErrorState message={state.error} {...(state.retryable ? { onRetry: state.reload } : {})} />
    );
  }
  if (!state.data) return <EmptyState title="No data available." />;

  const { summary } = state.data;

  return (
    <div className="view view-models">
      <div className="view-header">
        <h2>Models</h2>
      </div>
      <p className="muted">
        {summary.modelUsageCount} model pins found. {summary.retiredModelCount} name a model that is
        already shut down, and {summary.outdatedModelCount - summary.retiredModelCount} name one
        with a shutdown announced. A model id that is not in the bundled vendor table is reported as
        unknown rather than as a problem, because a newly released model would otherwise look dead.
      </p>

      <div className="toolbar">
        <label htmlFor="models-filter">Show</label>
        <select
          id="models-filter"
          value={filter}
          onChange={(event) => setFilter(event.target.value as Filter)}
        >
          <option value="outdated">Retired or scheduled only</option>
          <option value="all">Every pin</option>
        </select>
      </div>

      {groups.length === 0 ? (
        <EmptyState
          title={
            filter === 'outdated'
              ? 'No pinned model is retired or scheduled for shutdown.'
              : 'No model is pinned anywhere.'
          }
        />
      ) : (
        <ul className="model-list">
          {groups.map((group) => (
            <ModelCard key={group.id} group={group} />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Groups by canonical id rather than by file, because a model pinned in eight
 * agents is one decision to revisit, not eight.
 */
function groupModels(usage: readonly ModelUsageEntry[], filter: Filter): ModelGroup[] {
  const groups = new Map<string, ModelGroup>();

  for (const entry of usage) {
    const { status } = entry.assessment;
    if (filter === 'outdated' && status !== 'retired' && status !== 'deprecated') continue;
    const id = entry.assessment.canonicalId ?? entry.assessment.normalized;
    const existing = groups.get(id);
    if (existing) existing.entries.push(entry);
    else groups.set(id, { id, status, entries: [entry] });
  }

  return [...groups.values()].sort(
    (a, b) =>
      STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
      b.entries.length - a.entries.length ||
      a.id.localeCompare(b.id),
  );
}

function ModelCard({ group }: { group: ModelGroup }): ReactElement {
  const first = group.entries[0];
  const assessment = first?.assessment;
  const outdated = group.status === 'retired' || group.status === 'deprecated';

  return (
    <li className={outdated ? 'model-card is-conflict' : 'model-card'}>
      <div className="model-card-header">
        <code>{group.id}</code>
        <Badge variant={STATUS_VARIANTS[group.status]}>{STATUS_LABELS[group.status]}</Badge>
        <span className="muted small">
          {group.entries.length} pin{group.entries.length === 1 ? '' : 's'}
        </span>
      </div>

      {assessment ? (
        <p className="muted small">
          {assessment.shutdownDate ? (
            <>
              {group.status === 'retired' ? 'Shut down' : 'Shuts down'} {assessment.shutdownDate}
              {assessment.daysUntilShutdown !== undefined
                ? ` (${assessment.daysUntilShutdown} days away)`
                : ''}
              {' \u00B7 '}
            </>
          ) : null}
          {assessment.replacement ? (
            <>
              Vendor suggests <code>{assessment.replacement}</code>
            </>
          ) : null}
          {assessment.note ? <> {assessment.note}</> : null}
          {assessment.sourceUrl ? (
            <>
              {' \u00B7 '}
              <a href={assessment.sourceUrl} target="_blank" rel="noreferrer noopener">
                Vendor deprecation notice
              </a>
            </>
          ) : null}
        </p>
      ) : null}

      <ul className="model-sites">
        {group.entries.map((entry) => (
          <li key={`${entry.fileId}:${entry.path}`}>
            <Badge variant={scopeVariant(entry.scope)}>{SCOPE_LABELS[entry.scope]}</Badge>{' '}
            <a href={`#/files/${encodeURIComponent(entry.fileId)}`}>{entry.displayPath}</a>{' '}
            <span className="muted small">
              {entry.entityName ? `${entry.entityName} \u00B7 ` : ''}
              <code>{entry.path}</code>
              {entry.reference === group.id ? '' : ` = ${entry.reference}`}
            </span>
          </li>
        ))}
      </ul>
    </li>
  );
}
