/**
 * About: what this build is, and whether a newer one exists.
 *
 * The update result is read from the API rather than fetched here, because the
 * decision to contact GitHub belongs to the CLI flag that started the process,
 * not to a page the browser happens to render. When the flag was not passed
 * this view says so explicitly and names the flag, so "no update information"
 * reads as a deliberate default rather than a broken feature.
 */

import type { ReactElement } from 'react';
import { getAbout } from '../api/client.js';
import { EmptyState, ErrorState, LoadingState } from '../components/StatusStates.js';
import { useAsync } from '../hooks/useAsync.js';
import type { UpdateCheck } from '../api/types.js';

function UpdateStatus({ check }: { check: UpdateCheck }): ReactElement {
  switch (check.status) {
    case 'outdated':
      return (
        <p className="notice notice-warning">
          <strong>
            Version {check.latestVersion} is available. You are running {check.currentVersion}.
          </strong>{' '}
          Run <code>npx ai-harness-helper@latest</code> to get it, or{' '}
          <a href={check.releaseUrl} target="_blank" rel="noreferrer noopener">
            read the release notes
          </a>
          .
        </p>
      );
    case 'current':
      return (
        <p className="notice notice-ok">
          <strong>Up to date.</strong> {check.currentVersion} is the latest published release.
        </p>
      );
    case 'failed':
      return (
        <p className="notice notice-error">
          <strong>The update check did not complete.</strong> {check.reason}
        </p>
      );
    case 'disabled':
      return (
        <p className="notice notice-info">
          <strong>No update check ran.</strong> This tool makes no network requests unless you ask
          it to. Start it with <code>npx ai-harness-helper --check-updates</code> to have it look up
          the latest release on GitHub.
        </p>
      );
  }
}

export function AboutView(): ReactElement {
  const about = useAsync(getAbout, []);

  if (about.loading) return <LoadingState label="Loading version information…" />;
  if (about.error) {
    return (
      <ErrorState message={about.error} {...(about.retryable ? { onRetry: about.reload } : {})} />
    );
  }
  if (!about.data) return <EmptyState title="No version information available." />;

  const { version, repositoryUrl, readOnly, updateCheck } = about.data;

  return (
    <div className="view view-about">
      <div className="view-header">
        <h2>About</h2>
        <span className="badge badge-neutral">v{version}</span>
      </div>
      <p className="muted">
        AI Harness Helper finds every agentic-tool configuration file on this machine and shows the
        whole picture in one place.
      </p>

      <section aria-labelledby="about-build">
        <h3 id="about-build">This build</h3>
        <dl className="about-facts">
          <dt>Version</dt>
          <dd>{version}</dd>
          <dt>Session</dt>
          <dd>{readOnly ? 'Read-only — editing is disabled' : 'Editing enabled'}</dd>
          <dt>Repository</dt>
          <dd>
            <a href={repositoryUrl} target="_blank" rel="noreferrer noopener">
              {repositoryUrl.replace('https://', '')}
            </a>
          </dd>
        </dl>
      </section>

      <section aria-labelledby="about-updates">
        <h3 id="about-updates">Updates</h3>
        <UpdateStatus check={updateCheck} />
      </section>

      <section aria-labelledby="about-privacy">
        <h3 id="about-privacy">Privacy</h3>
        <p className="muted">
          Nothing about your configuration ever leaves this machine. There is no telemetry, the
          server binds the loopback interface only, and the sole outbound request the tool can make
          is the release lookup behind <code>--check-updates</code> — which sends only a version
          number and runs only when you pass that flag.
        </p>
      </section>
    </div>
  );
}
