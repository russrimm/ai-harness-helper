/**
 * Ctrl/Cmd+K: jump anywhere.
 *
 * A harness of any size produces more rows than any tree can show at once, and
 * the thing people actually want is rarely "browse" — it is "take me to the
 * `github` server" or "open my CLAUDE.md". Navigation menus answer the first
 * question well and the second one badly.
 *
 * Data is fetched once, on first open, rather than with the app: the palette
 * is optional, and paying for its index on every page load would slow the
 * first paint for people who never press the shortcut.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { getInventory, getScan } from '../api/client.js';

interface Command {
  id: string;
  label: string;
  hint: string;
  group: string;
  href: string;
}

const STATIC_COMMANDS: readonly Command[] = [
  { id: 'nav-overview', label: 'Overview', hint: 'Dashboard', group: 'Go to', href: '#/' },
  {
    id: 'nav-review',
    label: 'Review',
    hint: 'Quality issues in skills, agents, and instructions',
    group: 'Go to',
    href: '#/review',
  },
  {
    id: 'nav-budget',
    label: 'Context budget',
    hint: 'What loads on every request',
    group: 'Go to',
    href: '#/budget',
  },
  {
    id: 'nav-sources',
    label: 'Sources',
    hint: 'Where config comes from',
    group: 'Go to',
    href: '#/sources',
  },
  { id: 'nav-files', label: 'Files', hint: 'Browse and edit', group: 'Go to', href: '#/files' },
  {
    id: 'nav-mcp',
    label: 'MCP servers',
    hint: 'Every server, every tool',
    group: 'Go to',
    href: '#/mcp',
  },
  {
    id: 'nav-capabilities',
    label: 'Skills & agents',
    hint: 'Form editor',
    group: 'Go to',
    href: '#/capabilities',
  },
  {
    id: 'nav-instructions',
    label: 'Instructions',
    hint: 'In precedence order',
    group: 'Go to',
    href: '#/instructions',
  },
  {
    id: 'nav-effective',
    label: 'Effective configuration',
    hint: 'What actually wins',
    group: 'Go to',
    href: '#/effective',
  },
  {
    id: 'nav-models',
    label: 'Models',
    hint: 'Pinned model lifecycle',
    group: 'Go to',
    href: '#/models',
  },
  { id: 'nav-search', label: 'Search', hint: 'Full text', group: 'Go to', href: '#/search' },
  { id: 'nav-export', label: 'Export', hint: 'JSON or Markdown', group: 'Go to', href: '#/export' },
  {
    id: 'nav-projects',
    label: 'Project roots',
    hint: 'Add a folder to the scan',
    group: 'Go to',
    href: '#/project-roots',
  },
];

const MAX_RESULTS = 40;

const OPEN_EVENT = 'ahh:open-palette';

/**
 * Opens the palette from anywhere.
 *
 * The header trigger uses this rather than lifting `open` into `App`, so the
 * palette keeps owning its own state — including the deferred index load,
 * which must still happen on first open and not on page load.
 */
export function openCommandPalette(): void {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT));
}

export function CommandPalette(): ReactElement | null {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [indexed, setIndexed] = useState<readonly Command[]>([]);
  const [loaded, setLoaded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  /** Where focus was before the dialog opened, so it can be handed back. */
  const restoreTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const combo = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k';
      if (combo) {
        event.preventDefault();
        restoreTo.current = document.activeElement as HTMLElement | null;
        setOpen((current) => !current);
      }
    };
    const onRequestOpen = (): void => {
      restoreTo.current = document.activeElement as HTMLElement | null;
      setOpen(true);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener(OPEN_EVENT, onRequestOpen);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener(OPEN_EVENT, onRequestOpen);
    };
  }, []);

  const loadIndex = useCallback(async (): Promise<void> => {
    try {
      const [scan, inventory] = await Promise.all([getScan(), getInventory()]);
      const commands: Command[] = [];

      for (const file of scan.files) {
        commands.push({
          id: `file:${file.id}`,
          label: file.name,
          hint: `${file.providerName} · ${file.directory}`,
          group: 'Files',
          href: `#/files/${encodeURIComponent(file.id)}`,
        });
      }
      for (const capability of inventory.capabilities) {
        commands.push({
          id: `capability:${capability.fileId}`,
          label: capability.name,
          hint: `${capability.kind} · ${capability.providerName}`,
          group: 'Skills & agents',
          href: `#/capabilities/${encodeURIComponent(capability.fileId)}`,
        });
      }
      for (const server of inventory.mcpServers) {
        const first = server.definitions[0];
        commands.push({
          id: `mcp:${server.name}`,
          label: server.name,
          hint: `MCP server · ${first?.providerName ?? server.providerIds.join(', ')}`,
          group: 'MCP servers',
          href: '#/mcp',
        });
      }

      setIndexed(commands);
    } catch {
      // The static navigation still works without the index, which is the part
      // people reach for most; failing loudly here would be worse than quiet.
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!open || loaded) return;
    void loadIndex();
  }, [open, loaded, loadIndex]);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      return;
    }
    setQuery('');
    setActive(0);
    restoreTo.current?.focus();
  }, [open]);

  const results = useMemo(() => {
    const all = [...STATIC_COMMANDS, ...indexed];
    const trimmed = query.trim().toLowerCase();
    if (trimmed.length === 0) return STATIC_COMMANDS.slice(0, MAX_RESULTS);
    const scored = all
      .map((command) => ({ command, score: score(command, trimmed) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.command.label.localeCompare(b.command.label));
    return scored.slice(0, MAX_RESULTS).map((entry) => entry.command);
  }, [query, indexed]);

  if (!open) return null;

  const go = (command: Command | undefined): void => {
    if (!command) return;
    window.location.hash = command.href.replace(/^#/, '');
    setOpen(false);
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((current) => (results.length === 0 ? 0 : (current + 1) % results.length));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current) =>
        results.length === 0 ? 0 : (current - 1 + results.length) % results.length,
      );
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      go(results[active]);
    }
  };

  const activeId = results[active] ? `palette-option-${results[active].id}` : undefined;

  return (
    <div className="palette-backdrop" onMouseDown={() => setOpen(false)}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Jump to"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          type="text"
          className="palette-input"
          placeholder="Jump to a view, file, skill, or server…"
          value={query}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-results"
          aria-autocomplete="list"
          {...(activeId ? { 'aria-activedescendant': activeId } : {})}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
        <ul className="palette-results" id="palette-results" role="listbox" aria-label="Results">
          {results.length === 0 ? (
            <li className="palette-empty">
              {loaded ? 'Nothing matches.' : 'Indexing your harness…'}
            </li>
          ) : (
            results.map((command, index) => (
              <li
                key={command.id}
                id={`palette-option-${command.id}`}
                role="option"
                aria-selected={index === active}
                className={index === active ? 'palette-option is-active' : 'palette-option'}
                onMouseEnter={() => setActive(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  go(command);
                }}
              >
                <span className="palette-option-label">{command.label}</span>
                <span className="palette-option-hint">{command.hint}</span>
                <span className="palette-option-group">{command.group}</span>
              </li>
            ))
          )}
        </ul>
        <p className="palette-footer muted small">
          <kbd>↑</kbd> <kbd>↓</kbd> to move · <kbd>Enter</kbd> to open · <kbd>Esc</kbd> to close
        </p>
      </div>
    </div>
  );
}

/**
 * Ranks a match.
 *
 * A prefix on the label beats a match anywhere in it, which beats a match in
 * the hint — so typing "cla" surfaces the `claude` server before a file that
 * merely lives in a Claude directory.
 */
function score(command: Command, query: string): number {
  const label = command.label.toLowerCase();
  if (label === query) return 100;
  if (label.startsWith(query)) return 80;
  if (label.includes(query)) return 60;
  if (command.hint.toLowerCase().includes(query)) return 30;
  return 0;
}
