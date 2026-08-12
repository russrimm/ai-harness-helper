/**
 * Dashboard: summary stats, detected tools, health findings, and rescan.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { getOverview, postScan } from '../api/client.js';
import { Badge } from '../components/Badge.js';
import { StatCard } from '../components/StatCard.js';
import { EmptyState, ErrorState, LoadingState } from '../components/StatusStates.js';
import { describeError, isRetryable } from '../hooks/useAsync.js';
import type { FindingSeverity, HealthFinding, OverviewResponse } from '../api/types.js';

const SEVERITY_ORDER: Record<FindingSeverity, number> = { error: 0, warning: 1, info: 2 };
const SEVERITY_VARIANT: Record<FindingSeverity, 'error' | 'warning' | 'info'> = {
  error: 'error',
  warning: 'warning',
  info: 'info',
};
const SEVERITY_LABELS: Record<FindingSeverity, string> = {
  error: 'Errors',
  warning: 'Warnings',
  info: 'Info',
};
const SEVERITIES: readonly FindingSeverity[] = ['error', 'warning', 'info'];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) return `${kilobytes.toFixed(1)} KB`;
  return `${(kilobytes / 1024).toFixed(1)} MB`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function OverviewView(): ReactElement {
  const [data, setData] = useState<OverviewResponse | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [retryable, setRetryable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [severityFilter, setSeverityFilter] = useState<Set<FindingSeverity>>(new Set());

  const load = useCallback(async (): Promise<OverviewResponse | undefined> => {
    setLoading(true);
    setError(undefined);
    setRetryable(true);
    try {
      const next = await getOverview();
      setData(next);
      return next;
    } catch (caught) {
      setError(describeError(caught));
      setRetryable(isRetryable(caught));
      return undefined;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleRescan = async (): Promise<void> => {
    setScanning(true);
    setAnnouncement('Rescanning…');
    try {
      await postScan();
      const next = await load();
      if (next) {
        const files = plural(next.summary.fileCount, 'config file');
        const findings = plural(next.summary.findingCount, 'finding');
        setAnnouncement(`Rescan complete. ${files}, ${findings}.`);
      } else {
        setAnnouncement('Rescan finished, but the results could not be loaded.');
      }
    } catch (caught) {
      setError(describeError(caught));
      setRetryable(isRetryable(caught));
      setAnnouncement('Rescan failed.');
    } finally {
      setScanning(false);
    }
  };

  const toggleSeverity = (severity: FindingSeverity): void => {
    setSeverityFilter((previous) => {
      const next = new Set(previous);
      if (next.has(severity)) next.delete(severity);
      else next.add(severity);
      return next;
    });
  };

  if (loading && !data) return <LoadingState label="Scanning your machine…" />;
  if (error && !data) {
    return <ErrorState message={error} {...(retryable ? { onRetry: () => void load() } : {})} />;
  }
  if (!data) return <EmptyState title="No scan data yet." />;

  const { summary } = data;

  const sortedFindings = [...data.findings].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
  const severityCounts: Record<FindingSeverity, number> = { error: 0, warning: 0, info: 0 };
  for (const finding of sortedFindings) severityCounts[finding.severity] += 1;
  const activeSeverities = SEVERITIES.filter((severity) => severityCounts[severity] > 0);

  // An empty filter means "everything", so the default view hides nothing.
  const visibleFindings =
    severityFilter.size === 0
      ? sortedFindings
      : sortedFindings.filter((finding) => severityFilter.has(finding.severity));

  const findingsHint =
    summary.findingCount === 0
      ? 'Nothing to review'
      : activeSeverities.map((one) => `${severityCounts[one]} ${one}`).join(', ');

  const scannedAtLabel = new Date(data.scannedAt).toLocaleString();
  const toolNames = new Map(data.tree.map((group) => [group.providerId, group.providerName]));

  return (
    <div className="view view-overview">
      <div className="view-header">
        <h2>Overview</h2>
        <button type="button" onClick={() => void handleRescan()} disabled={scanning}>
          {scanning ? 'Rescanning…' : 'Rescan'}
        </button>
      </div>
      <p role="status" aria-live="polite" className="visually-hidden">
        {announcement}
      </p>

      {/*
       * A failure *after* the first successful load leaves stale numbers on
       * screen, so it needs its own banner: the full-page error state above
       * only renders when there is nothing to show at all, which meant a
       * failed rescan previously did nothing visible whatsoever.
       */}
      {error ? (
        <div className="notice notice-error" role="alert">
          <p>
            <strong>That did not work.</strong> {error}
          </p>
          {retryable ? (
            <div className="notice-actions">
              <button type="button" onClick={() => void load()} disabled={loading}>
                {loading ? 'Retrying…' : 'Try again'}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      <section aria-labelledby="inventory-heading">
        <h3 id="inventory-heading">Inventory</h3>
        <div className="stat-grid">
          <StatCard
            label="Tools detected"
            value={summary.providerCount}
            hint="See every location"
            href="#/sources"
          />
          <StatCard
            label="Config files"
            value={summary.fileCount}
            hint={formatBytes(summary.totalBytes)}
            href="#/files"
          />
          <StatCard
            label="Directories"
            value={summary.directoryCount}
            hint="Holding configuration"
            href="#/sources"
          />
          <StatCard
            label="MCP servers"
            value={summary.mcpServerCount}
            hint={plural(summary.mcpDefinitionCount, 'definition')}
            href="#/mcp"
          />
          <StatCard
            label="Instruction files"
            value={summary.instructionCount}
            hint="In precedence order"
            href="#/instructions"
          />
          <StatCard
            label="Capabilities"
            value={summary.capabilityCount}
            hint="Agents, skills, prompts"
            href="#/instructions"
          />
          <StatCard
            label="Guardrails"
            value={summary.guardrailCount}
            hint="Permissions, hooks, ignores"
            href="#/instructions"
          />
        </div>
        <p className="muted">
          Scanned <time dateTime={data.scannedAt}>{scannedAtLabel}</time> on {data.platform} in{' '}
          {data.durationMs} ms.
          {data.missingCount > 0
            ? ` ${data.missingCount} known locations were not present.`
            : ''}{' '}
          <a href="#/sources">See where every setting comes from</a>.
        </p>
      </section>

      <section aria-labelledby="detected-tools-heading">
        <h3 id="detected-tools-heading">Detected tools</h3>
        {data.detectedProviders.length === 0 ? (
          <EmptyState
            title="No agentic AI tool configuration was found on this machine."
            detail="Install a supported tool, or add a project root and rescan."
          />
        ) : (
          <ul className="chip-list">
            {data.detectedProviders.map((id) => (
              <li key={id}>
                <span className="chip">{toolNames.get(id) ?? id}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="findings-heading">
        <h3 id="findings-heading">Health</h3>
        <div className="stat-grid">
          <StatCard
            label="Duplicates"
            value={summary.duplicateCount}
            hint="Declared in more than one place — often deliberate"
            {...(summary.duplicateCount > 0 ? { tone: 'warning' as const } : {})}
          />
          <StatCard
            label="Conflicts"
            value={summary.conflictCount}
            hint="One tool, one scope, two answers"
            {...(summary.conflictCount > 0 ? { tone: 'error' as const } : {})}
          />
          <StatCard
            label="Findings"
            value={summary.findingCount}
            hint={findingsHint}
            tone={
              summary.errorCount > 0 ? 'error' : summary.warningCount > 0 ? 'warning' : undefined
            }
          />
        </div>
        {sortedFindings.length === 0 ? (
          <EmptyState title="No issues found. Your harness looks tidy." />
        ) : (
          <>
            <ul className="chip-toggle-list" aria-label="Filter findings by severity">
              {activeSeverities.map((severity) => (
                <li key={severity}>
                  <button
                    type="button"
                    className="chip-toggle"
                    aria-pressed={severityFilter.has(severity)}
                    onClick={() => toggleSeverity(severity)}
                  >
                    {SEVERITY_LABELS[severity]} ({severityCounts[severity]})
                  </button>
                </li>
              ))}
              {severityFilter.size > 0 ? (
                <li>
                  <button
                    type="button"
                    className="chip-toggle"
                    onClick={() => setSeverityFilter(new Set())}
                  >
                    Clear filter
                  </button>
                </li>
              ) : null}
            </ul>
            <p className="muted small" role="status" aria-live="polite">
              Showing {visibleFindings.length} of {plural(sortedFindings.length, 'finding')}.
            </p>
            {visibleFindings.length === 0 ? (
              <EmptyState
                title="No findings match that severity."
                detail="Clear the filter to see everything again."
              />
            ) : (
              <ul className="findings-list">
                {visibleFindings.map((finding) => (
                  <FindingRow key={finding.id} finding={finding} />
                ))}
              </ul>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function FindingRow({ finding }: { finding: HealthFinding }): ReactElement {
  return (
    <li className={`finding-row finding-${finding.severity}`}>
      <Badge variant={SEVERITY_VARIANT[finding.severity]} className="finding-badge">
        {finding.severity}
      </Badge>
      <div className="finding-body">
        <p className="finding-title">{finding.title}</p>
        <p className="finding-detail">{finding.detail}</p>
        {finding.remediation ? (
          <p className="finding-remediation">Suggestion: {finding.remediation}</p>
        ) : null}
        {finding.fileIds.length > 0 ? (
          <ul className="finding-files">
            {finding.fileIds.map((fileId, index) => (
              <li key={fileId}>
                <a href={`#/files/${encodeURIComponent(fileId)}`}>
                  {finding.displayPaths[index] ?? fileId}
                </a>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </li>
  );
}
