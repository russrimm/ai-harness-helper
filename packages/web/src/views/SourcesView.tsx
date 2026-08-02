/**
 * The "where does this come from?" map.
 *
 * Every supported tool, every location it reads, the directory each one
 * resolves to on this machine, and whether anything is actually there. Absent
 * locations are shown by default because the most common harness question is
 * not "what did I configure?" but "why is this tool ignoring my config?" —
 * and the answer is usually that the file is somewhere the tool never looks.
 */

import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { getSources } from '../api/client.js';
import { Badge, scopeVariant } from '../components/Badge.js';
import { EmptyState, ErrorState, LoadingState } from '../components/StatusStates.js';
import { useAsync } from '../hooks/useAsync.js';
import { SCOPE_LABELS } from '../lib/scope.js';
import type { SourceLocation, SourceProvider } from '../api/types.js';

const CATEGORY_LABELS: Record<SourceProvider['category'], string> = {
  'agent-cli': 'Agent CLI',
  editor: 'Editor',
  'desktop-app': 'Desktop app',
  runtime: 'Runtime',
  universal: 'Universal',
};

function matchesQuery(provider: SourceProvider, needle: string): boolean {
  if (needle.length === 0) return true;
  if (provider.providerName.toLowerCase().includes(needle)) return true;
  if (provider.providerId.toLowerCase().includes(needle)) return true;
  return provider.locations.some(
    (location) =>
      location.locationLabel.toLowerCase().includes(needle) ||
      location.directories.some((directory) => directory.toLowerCase().includes(needle)) ||
      location.checkedPaths.some((path) => path.toLowerCase().includes(needle)) ||
      location.templates.some((template) => template.toLowerCase().includes(needle)),
  );
}

export function SourcesView(): ReactElement {
  const sources = useAsync(getSources, []);
  const [query, setQuery] = useState('');
  const [showAbsent, setShowAbsent] = useState(false);

  const needle = query.trim().toLowerCase();
  const providers = useMemo(() => {
    const all = sources.data?.providers ?? [];
    return all
      .filter((provider) => showAbsent || provider.detected)
      .filter((provider) => matchesQuery(provider, needle));
  }, [sources.data, showAbsent, needle]);

  if (sources.loading) return <LoadingState label="Mapping configuration sources…" />;
  if (sources.error) {
    return (
      <ErrorState
        message={sources.error}
        {...(sources.retryable ? { onRetry: sources.reload } : {})}
      />
    );
  }
  if (!sources.data) return <EmptyState title="No data available." />;

  const { totals, home, platform, projectRoots } = sources.data;

  return (
    <div className="view view-sources">
      <div className="view-header">
        <h2>Sources</h2>
      </div>
      <p className="muted">
        {totals.detectedProviders} of {totals.providers} supported tools have configuration here.{' '}
        {totals.activeLocations} of {totals.locations} known locations are in use, across{' '}
        {totals.directories} director{totals.directories === 1 ? 'y' : 'ies'} and {totals.files}{' '}
        file{totals.files === 1 ? '' : 's'}. Home is <code>{home}</code> on {platform}.
      </p>
      {projectRoots.length === 0 ? (
        <p className="muted small">
          No project roots are registered, so project-scoped locations are shown as templates only.
          Add a root on the Overview page to resolve them.
        </p>
      ) : null}

      <div className="toolbar">
        <label htmlFor="sources-filter">Filter by tool, folder, or path</label>
        <input
          id="sources-filter"
          type="search"
          value={query}
          placeholder="cursor, ~/.claude, mcp.json"
          onChange={(event) => setQuery(event.target.value)}
        />
        <label className="toolbar-check">
          <input
            type="checkbox"
            checked={showAbsent}
            onChange={(event) => setShowAbsent(event.target.checked)}
          />
          Show tools with nothing configured
        </label>
      </div>

      {providers.length === 0 ? (
        <EmptyState
          title="No tools match this filter."
          detail="Clear the filter, or include tools with nothing configured."
        />
      ) : (
        <ul className="source-list">
          {providers.map((provider) => (
            <ProviderCard key={provider.providerId} provider={provider} showAbsent={showAbsent} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ProviderCard({
  provider,
  showAbsent,
}: {
  provider: SourceProvider;
  showAbsent: boolean;
}): ReactElement {
  const locations = showAbsent
    ? provider.locations
    : provider.locations.filter((location) => location.status === 'active');
  const visible = locations.length > 0 ? locations : provider.locations;

  return (
    <li className="source-card">
      <div className="source-card-header">
        <h3>{provider.providerName}</h3>
        <Badge variant={provider.detected ? 'ok' : 'neutral'}>
          {provider.detected ? `${provider.fileCount} file(s)` : 'Nothing found'}
        </Badge>
        <span className="chip chip-quiet">{CATEGORY_LABELS[provider.category]}</span>
        <span className="muted small">
          {provider.activeLocationCount}/{provider.locationCount} locations in use
        </span>
        {provider.docsUrl ? (
          <a href={provider.docsUrl} target="_blank" rel="noreferrer noopener">
            Docs
          </a>
        ) : null}
      </div>
      <p className="muted">{provider.description}</p>

      {provider.directories.length > 0 ? (
        <p className="source-directories">
          <span className="label">Directories:</span>{' '}
          {provider.directories.map((directory) => (
            <code key={directory}>{directory}</code>
          ))}
        </p>
      ) : null}

      <div
        className="table-scroll source-table-scroll"
        role="region"
        aria-label={`${provider.providerName} configuration locations`}
        tabIndex={0}
      >
        <table className="source-table">
          <caption className="visually-hidden">
            {provider.providerName} configuration locations
          </caption>
          <thead>
            <tr>
              <th scope="col">Location</th>
              <th scope="col">Scope</th>
              <th scope="col">Kind</th>
              <th scope="col">Directory</th>
              <th scope="col">Status</th>
              <th scope="col">Files</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((location) => (
              <LocationRow
                key={`${location.locationId}:${location.projectRoot ?? ''}`}
                location={location}
              />
            ))}
          </tbody>
        </table>
      </div>
    </li>
  );
}

function LocationRow({ location }: { location: SourceLocation }): ReactElement {
  const directories =
    location.directories.length > 0
      ? location.directories
      : location.checkedPaths.length > 0
        ? location.checkedPaths.map(parentOf)
        : location.templates.map(parentOf);

  return (
    <tr className={location.status === 'active' ? 'source-row-active' : 'source-row-absent'}>
      <th scope="row">
        {location.locationLabel}
        {location.deprecated ? <Badge variant="warning">Deprecated</Badge> : null}
        {location.note ? <span className="muted small note">{location.note}</span> : null}
      </th>
      <td>
        <Badge variant={scopeVariant(location.scope)}>{SCOPE_LABELS[location.scope]}</Badge>
      </td>
      <td>{location.kind}</td>
      <td className="source-directory">
        {directories.length === 0 ? (
          '\u2014'
        ) : (
          <ul>
            {[...new Set(directories)].map((directory) => (
              <li key={directory}>
                <code>{directory}</code>
              </li>
            ))}
          </ul>
        )}
      </td>
      <td>
        {location.status === 'active' ? (
          <Badge variant="ok">In use</Badge>
        ) : (
          <Badge variant="neutral">Not present</Badge>
        )}
      </td>
      <td>
        {location.files.length === 0 ? (
          <span className="muted small">
            Checked:{' '}
            {(location.checkedPaths.length > 0 ? location.checkedPaths : location.templates).join(
              ', ',
            ) || '\u2014'}
          </span>
        ) : (
          <ul className="source-files">
            {location.files.map((file) => (
              <li key={file.fileId}>
                <a href={`#/files/${encodeURIComponent(file.fileId)}`}>{file.name}</a>{' '}
                {location.directories.length > 1 ? (
                  <span className="muted small">
                    in <code>{file.directory}</code>
                  </span>
                ) : null}{' '}
                <span className="muted small">
                  {file.editable ? 'editable' : (file.notEditableReason ?? 'read-only')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </td>
    </tr>
  );
}

/** Strips the final segment of a path or template, so a file becomes its folder. */
function parentOf(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return index > 0 ? path.slice(0, index) : path;
}
