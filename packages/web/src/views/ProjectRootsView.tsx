/**
 * Project-root management: add a repository folder so its project-scoped
 * configuration (e.g. `.vscode`, `.cursor`, `AGENTS.md`) is also scanned.
 *
 * Moved out of the Overview dashboard into its own view so it is reachable
 * from top-level navigation instead of being buried at the bottom of the
 * page.
 */

import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { addProject, getOverview, removeProject } from '../api/client.js';
import { EmptyState, ErrorState, LoadingState } from '../components/StatusStates.js';
import { describeError, isRetryable } from '../hooks/useAsync.js';
import type { ProjectRootInfo } from '../api/types.js';

/** Outcome of the last project-root change, so a success is visible too. */
interface RootFeedback {
  tone: 'ok' | 'error';
  text: string;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function ProjectRootsView(): ReactElement {
  const [roots, setRoots] = useState<ProjectRootInfo[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [retryable, setRetryable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [newRoot, setNewRoot] = useState('');
  const [rootBusy, setRootBusy] = useState<string | undefined>(undefined);
  const [rootFeedback, setRootFeedback] = useState<RootFeedback | undefined>(undefined);
  const [pendingRemoval, setPendingRemoval] = useState<string | undefined>(undefined);

  const load = useCallback(async (): Promise<ProjectRootInfo[] | undefined> => {
    setLoading(true);
    setError(undefined);
    setRetryable(true);
    try {
      const next = await getOverview();
      setRoots(next.projectRoots);
      return next.projectRoots;
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

  const handleAddRoot = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const path = newRoot.trim();
    if (path.length === 0) return;
    setRootBusy(path);
    setRootFeedback(undefined);
    try {
      await addProject(path);
      setNewRoot('');
      const next = await load();
      const added = next?.find((root) => root.path === path);
      setRootFeedback({
        tone: 'ok',
        text: added
          ? `Added ${added.path} — ${plural(added.fileCount, 'file')} found.`
          : `Added ${path}.`,
      });
    } catch (caught) {
      setRootFeedback({ tone: 'error', text: describeError(caught) });
    } finally {
      setRootBusy(undefined);
    }
  };

  const handleRemoveRoot = async (path: string): Promise<void> => {
    setRootBusy(path);
    setRootFeedback(undefined);
    try {
      await removeProject(path);
      setPendingRemoval(undefined);
      await load();
      setRootFeedback({
        tone: 'ok',
        text: `Removed ${path}. Nothing on disk changed — add the path again to restore it.`,
      });
    } catch (caught) {
      setRootFeedback({ tone: 'error', text: describeError(caught) });
    } finally {
      setRootBusy(undefined);
    }
  };

  if (loading && !roots) return <LoadingState label="Loading project roots…" />;
  if (error && !roots) {
    return <ErrorState message={error} {...(retryable ? { onRetry: () => void load() } : {})} />;
  }

  return (
    <div className="view view-project-roots">
      <div className="view-header">
        <h2>Project roots</h2>
      </div>

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

      <section aria-labelledby="project-roots-heading">
        <p className="muted" id="project-roots-heading">
          Add a repository folder to also scan its project-scoped configuration (e.g. `.vscode`,
          `.cursor`, `AGENTS.md`).
        </p>
        {!roots || roots.length === 0 ? (
          <EmptyState title="No project roots configured yet." />
        ) : (
          <ul className="root-list">
            {roots.map((root) => (
              <li key={root.path}>
                <span className="root-path">{root.path}</span>
                <span className="muted">{plural(root.fileCount, 'file')}</span>
                {/*
                 * Two-step rather than `confirm()`: removing a root discards a
                 * path the user typed by hand, and an inline confirmation stays
                 * keyboard-operable and readable by a screen reader.
                 */}
                {pendingRemoval === root.path ? (
                  <>
                    <span className="muted small">Stop scanning this folder?</span>
                    <button
                      type="button"
                      onClick={() => void handleRemoveRoot(root.path)}
                      disabled={rootBusy === root.path}
                    >
                      {rootBusy === root.path ? 'Removing…' : 'Confirm'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setPendingRemoval(undefined)}
                      disabled={rootBusy === root.path}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => setPendingRemoval(root.path)}
                    disabled={rootBusy !== undefined}
                    aria-label={`Remove project root ${root.path}`}
                  >
                    Remove
                  </button>
                )}
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
        {rootFeedback?.tone === 'error' ? (
          <p role="alert" className="state-error-inline">
            {rootFeedback.text}
          </p>
        ) : null}
        {rootFeedback?.tone === 'ok' ? (
          <p role="status" aria-live="polite" className="muted">
            {rootFeedback.text}
          </p>
        ) : null}
      </section>
    </div>
  );
}
