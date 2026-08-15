import type { ReactElement } from 'react';

const LINKS: Array<{ path: string; label: string }> = [
  { path: '/', label: 'Overview' },
  { path: '/sources', label: 'Sources' },
  { path: '/files', label: 'Files' },
  { path: '/mcp', label: 'MCP' },
  { path: '/capabilities', label: 'Skills & agents' },
  { path: '/instructions', label: 'Instructions' },
  { path: '/effective', label: 'Effective' },
  { path: '/models', label: 'Models' },
  { path: '/search', label: 'Search' },
  { path: '/export', label: 'Export' },
];

const PROJECT_ROOTS_PATH = '/project-roots';

export function Nav({ currentBase }: { currentBase: string }): ReactElement {
  return (
    <nav aria-label="Main">
      <ul className="nav-list">
        {LINKS.map((link) => {
          const active = link.path === currentBase;
          return (
            <li key={link.path}>
              <a href={`#${link.path}`} aria-current={active ? 'page' : undefined}>
                {link.label}
              </a>
            </li>
          );
        })}
        <li>
          <a
            href={`#${PROJECT_ROOTS_PATH}`}
            className="nav-link-highlight"
            aria-current={currentBase === PROJECT_ROOTS_PATH ? 'page' : undefined}
          >
            <span aria-hidden="true">＋</span> Project Roots
          </a>
        </li>
      </ul>
    </nav>
  );
}
