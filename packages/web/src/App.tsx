import { lazy, Suspense, type ReactElement } from 'react';
import { getHealth } from './api/client.js';
import { CommandPalette } from './components/CommandPalette.js';
import { Nav } from './components/Nav.js';
import { LoadingState } from './components/StatusStates.js';
import { ThemeToggle } from './components/ThemeToggle.js';
import { ViewErrorBoundary } from './components/ViewErrorBoundary.js';
import { useAsync } from './hooks/useAsync.js';
import { splitFirstSegment, useHashLocation } from './hooks/useHashLocation.js';
import { useTheme } from './hooks/useTheme.js';

const OverviewView = lazy(async () => {
  const module = await import('./views/OverviewView.js');
  return { default: module.OverviewView };
});
const SourcesView = lazy(async () => {
  const module = await import('./views/SourcesView.js');
  return { default: module.SourcesView };
});
const ProjectRootsView = lazy(async () => {
  const module = await import('./views/ProjectRootsView.js');
  return { default: module.ProjectRootsView };
});
const FilesView = lazy(async () => {
  const module = await import('./views/FilesView.js');
  return { default: module.FilesView };
});
const McpView = lazy(async () => {
  const module = await import('./views/McpView.js');
  return { default: module.McpView };
});
const CapabilitiesView = lazy(async () => {
  const module = await import('./views/CapabilitiesView.js');
  return { default: module.CapabilitiesView };
});
const InstructionsView = lazy(async () => {
  const module = await import('./views/InstructionsView.js');
  return { default: module.InstructionsView };
});
const EffectiveView = lazy(async () => {
  const module = await import('./views/EffectiveView.js');
  return { default: module.EffectiveView };
});
const ModelsView = lazy(async () => {
  const module = await import('./views/ModelsView.js');
  return { default: module.ModelsView };
});
const SearchView = lazy(async () => {
  const module = await import('./views/SearchView.js');
  return { default: module.SearchView };
});
const ExportView = lazy(async () => {
  const module = await import('./views/ExportView.js');
  return { default: module.ExportView };
});
const ReviewView = lazy(async () => {
  const module = await import('./views/ReviewView.js');
  return { default: module.ReviewView };
});
const BudgetView = lazy(async () => {
  const module = await import('./views/BudgetView.js');
  return { default: module.BudgetView };
});

const KNOWN_BASES = [
  '/',
  '/review',
  '/budget',
  '/sources',
  '/files',
  '/mcp',
  '/capabilities',
  '/instructions',
  '/effective',
  '/models',
  '/search',
  '/export',
  '/project-roots',
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
            <span className="palette-hint muted small" aria-hidden="true">
              <kbd>Ctrl</kbd>+<kbd>K</kbd>
            </span>
            <ThemeToggle theme={theme} />
          </div>
        </div>
        <Nav currentBase={base} />
      </header>
      <main id="main-content">
        {/* Keyed by route so navigating away clears a failed view. */}
        <ViewErrorBoundary key={base}>
          <Suspense fallback={<LoadingState label="Loading view…" />}>
            {base === '/sources' ? <SourcesView /> : null}
            {base === '/review' ? <ReviewView /> : null}
            {base === '/budget' ? <BudgetView /> : null}
            {base === '/files' ? <FilesView initialFileId={rest} /> : null}
            {base === '/mcp' ? <McpView /> : null}
            {base === '/capabilities' ? <CapabilitiesView initialFileId={rest} /> : null}
            {base === '/instructions' ? <InstructionsView /> : null}
            {base === '/effective' ? <EffectiveView /> : null}
            {base === '/models' ? <ModelsView /> : null}
            {base === '/search' ? (
              <SearchView initialQuery={location.params.get('q') ?? ''} />
            ) : null}
            {base === '/export' ? <ExportView /> : null}
            {base === '/project-roots' ? <ProjectRootsView /> : null}
            {base === '/' ? <OverviewView /> : null}
            {!KNOWN_BASES.includes(base) ? <NotFound /> : null}
          </Suspense>
        </ViewErrorBoundary>
      </main>
      <CommandPalette />
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
