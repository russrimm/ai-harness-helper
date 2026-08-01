/**
 * Dashboard: summary stats, detected tools, health findings, rescan, and
 * project-root management.
 */

import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { addProject, getOverview, postScan, removeProject } from '../api/client.js';
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

export function OverviewView(): ReactElement {
  const [data, setData] = useState<OverviewResponse | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [retryable, setRetryable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [newRoot, setNewRoot] = useState('');
  const [rootBusy, setRootBusy] = useState<string | undefined>(undefined);
  const [rootMessage, setRootMessage] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    setRetryable(true);
    try {
      setData(await getOverview());
    } catch (caught) {
      setError(describeError(caught));
      setRetryable(isRetryable(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleRescan = async (): Promise<void> => {
    setScanning(true);
    try {
      await postScan();
      await load();
    } catch (caught) {
      setError(describeError(caught));
      setRetryable(isRetryable(caught));
    } finally {
      setScanning(false);
    }
  };

  const handleAddRoot = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const path = newRoot.trim();
    if (path.length === 0) return;
    setRootBusy(path);
    setRootMessage(undefined);
    try {
      await addProject(path);
      setNewRoot('');
      await load();
    } catch (caught) {
      setRootMessage(describeError(caught));
    } finally {
      setRootBusy(undefined);
    }
  };

  const handleRemoveRoot = async (path: string): Promise<void> => {
    setRootBusy(path);
    setRootMessage(undefined);
    try {
      await removeProject(path);
      await load();
    } catch (caught) {
      setRootMessage(describeError(caught));
    } finally {
      setRootBusy(undefined);
    }
  };

  if (loading && !data) return <LoadingState label="Scanning your machine…" />;
  if (error && !data) {
    return <ErrorState message={error} {...(retryable ? { onRetry: () => void load() } : {})} />;
  }
  if (!data) return <EmptyState title="No scan data yet." />;

  const sortedFindings = [...data.findings].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );

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
        {scanning ? 'Rescanning…' : ''}
      </p>

      <section aria-label="Summary">
        <div className="stat-grid">
          <StatCard label="Tools detected" value={data.summary.providerCount} />
          <StatCard label="Config files" value={data.summary.fileCount} />
          <StatCard label="MCP servers" value={data.summary.mcpServerCount} />
          <StatCard
            label="Findings"
            value={data.summary.findingCount}
            tone={
              data.summary.errorCount > 0
                ? 'error'
                : data.summary.warningCount > 0
                  ? 'warning'
                  : undefined
            }
          />
        </div>
        <p className="muted">
          Scanned {new Date(data.scannedAt).toLocaleString()} on {data.platform} in{' '}
          {data.durationMs} ms.
          {data.missingCount > 0 ? ` ${data.missingCount} known locations were not present.` : ''}
        </p>
      </section>

      <section aria-labelledby="detected-tools-heading">
        <h3 id="detected-tools-heading">Detected tools</h3>
        {data.detectedProviders.length === 0 ? (
          <EmptyState
            title="No agentic AI tool configuration was found on this machine."
            detail="Install a supported tool, or add a project root below and rescan."
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
        <h3 id="findings-heading">Health findings</h3>
        {sortedFindings.length === 0 ? (
          <EmptyState title="No issues found. Your harness looks tidy." />
        ) : (
          <ul className="findings-list">
            {sortedFindings.map((finding) => (
              <FindingRow key={finding.id} finding={finding} />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="project-roots-heading">
        <h3 id="project-roots-heading">Project roots</h3>
        <p className="muted">
          Add a repository folder to also scan its project-scoped configuration (e.g. `.vscode`,
          `.cursor`, `AGENTS.md`).
        </p>
        {data.projectRoots.length === 0 ? (
          <p className="muted">No project roots configured yet.</p>
        ) : (
          <ul className="root-list">
            {data.projectRoots.map((root) => (
              <li key={root.path}>
                <span className="root-path">{root.path}</span>
                <span className="muted">
                  {root.fileCount} file{root.fileCount === 1 ? '' : 's'}
                </span>
                <button
                  type="button"
                  onClick={() => void handleRemoveRoot(root.path)}
                  disabled={rootBusy === root.path}
                  aria-label={`Remove project root ${root.path}`}
                >
                  {rootBusy === root.path ? 'Removing…' : 'Remove'}
                </button>
              </li>
            ))}
          </ul>
        )}
        <form className="root-form" onSubmit={(event) => void handleAddRoot(event)}>
          <label htmlFor="new-root-path">Add project root</label>
          <div className="root-form-row">
            <input
              id="new-root-path"
              type="text"
              placeholder="C:\repos\my-project"
              value={newRoot}
              onChange={(event) => setNewRoot(event.target.value)}
            />
            <button type="submit" disabled={newRoot.trim().length === 0 || rootBusy !== undefined}>
              {rootBusy === newRoot.trim() ? 'Adding…' : 'Add'}
            </button>
          </div>
        </form>
        {rootMessage ? (
          <p role="alert" className="state-error-inline">
            {rootMessage}
          </p>
        ) : null}
      </section>
    </div>
  );
}

function FindingRow({ finding }: { finding: HealthFinding }): ReactElement {
  return (
    <li className={`finding-row finding-${finding.severity}`}>
      <Badge variant={SEVERITY_VARIANT[finding.severity]}>{finding.severity}</Badge>
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
