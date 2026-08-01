import type { ReactElement } from 'react';
import { getHealth } from './api/client.js';
import { Nav } from './components/Nav.js';
import { ThemeToggle } from './components/ThemeToggle.js';
import { ViewErrorBoundary } from './components/ViewErrorBoundary.js';
import { useAsync } from './hooks/useAsync.js';
import { splitFirstSegment, useHashLocation } from './hooks/useHashLocation.js';
import { useTheme } from './hooks/useTheme.js';
import { ExportView } from './views/ExportView.js';
import { CapabilitiesView } from './views/CapabilitiesView.js';
import { FilesView } from './views/FilesView.js';
import { InstructionsView } from './views/InstructionsView.js';
import { McpView } from './views/McpView.js';
import { OverviewView } from './views/OverviewView.js';
import { SearchView } from './views/SearchView.js';
import { SourcesView } from './views/SourcesView.js';

const KNOWN_BASES = [
  '/',
  '/sources',
  '/files',
  '/mcp',
  '/capabilities',
  '/instructions',
  '/search',
  '/export',
];

export function App(): ReactElement {
  const location = useHashLocation();
  const { base, rest } = splitFirstSegment(location.path);
  const theme = useTheme();
  const health = useAsync(getHealth, []);

  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <header className="app-header">
        <div className="app-header-row">
          <h1>AI Harness Helper</h1>
          <div className="app-header-actions">
            {health.data?.readOnly ? (
              <span className="badge badge-warning">
                <span aria-hidden="true">&#9888;</span> Read-only session
              </span>
            ) : null}
            <ThemeToggle theme={theme} />
          </div>
        </div>
        <Nav currentBase={base} />
      </header>
      <main id="main-content">
        {/* Keyed by route so navigating away clears a failed view. */}
        <ViewErrorBoundary key={base}>
          {base === '/sources' ? <SourcesView /> : null}
          {base === '/files' ? <FilesView initialFileId={rest} /> : null}
          {base === '/mcp' ? <McpView /> : null}
          {base === '/capabilities' ? <CapabilitiesView initialFileId={rest} /> : null}
          {base === '/instructions' ? <InstructionsView /> : null}
          {base === '/search' ? <SearchView initialQuery={location.params.get('q') ?? ''} /> : null}
          {base === '/export' ? <ExportView /> : null}
          {base === '/' ? <OverviewView /> : null}
          {!KNOWN_BASES.includes(base) ? <NotFound /> : null}
        </ViewErrorBoundary>
      </main>
    </>
  );
}

function NotFound(): ReactElement {
  return (
    <div className="state-message">
      <p>
        <strong>Unknown view.</strong> Use the navigation above to find your way back.
      </p>
    </div>
  );
}
