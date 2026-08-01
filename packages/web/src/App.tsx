import { lazy, Suspense } from 'react';
import type { ReactElement } from 'react';
import { getHealth } from './api/client.js';
import { Nav } from './components/Nav.js';
import { LoadingState } from './components/StatusStates.js';
import { ThemeToggle } from './components/ThemeToggle.js';
import { useAsync } from './hooks/useAsync.js';
import { splitFirstSegment, useHashLocation } from './hooks/useHashLocation.js';
import { useTheme } from './hooks/useTheme.js';

const ExportView = lazy(async () => ({
  default: (await import('./views/ExportView.js')).ExportView,
}));
const FilesView = lazy(async () => ({
  default: (await import('./views/FilesView.js')).FilesView,
}));
const InstructionsView = lazy(async () => ({
  default: (await import('./views/InstructionsView.js')).InstructionsView,
}));
const McpView = lazy(async () => ({
  default: (await import('./views/McpView.js')).McpView,
}));
const OverviewView = lazy(async () => ({
  default: (await import('./views/OverviewView.js')).OverviewView,
}));
const SearchView = lazy(async () => ({
  default: (await import('./views/SearchView.js')).SearchView,
}));

const KNOWN_BASES = ['/', '/files', '/mcp', '/instructions', '/search', '/export'];

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
        <Suspense fallback={<LoadingState label="Loading view…" />}>
          {base === '/files' ? <FilesView initialFileId={rest} /> : null}
          {base === '/mcp' ? <McpView /> : null}
          {base === '/instructions' ? <InstructionsView /> : null}
          {base === '/search' ? <SearchView initialQuery={location.params.get('q') ?? ''} /> : null}
          {base === '/export' ? <ExportView /> : null}
          {base === '/' ? <OverviewView /> : null}
          {!KNOWN_BASES.includes(base) ? <NotFound /> : null}
        </Suspense>
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
