/**
 * Unified view of every MCP server declared anywhere in the harness.
 *
 * Three questions get answered here: is one name declared inconsistently
 * (conflict), do differently *named* servers do the same job (overlap), and
 * how do I get rid of one I no longer want (removal). Overlap lives in its own
 * panel rather than the table because it is a claim about capability rather
 * than about configuration, and each group shows the evidence behind it so the
 * user can disagree with the inference.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { deleteMcpServer, getHealth, getInventory } from '../api/client.js';
import { Badge } from '../components/Badge.js';
import { EmptyState, ErrorState, LoadingState } from '../components/StatusStates.js';
import { useAsync } from '../hooks/useAsync.js';
import { SCOPE_LABELS } from '../lib/scope.js';
import type { BadgeVariant } from '../components/Badge.js';
import type {
  McpDefinition,
  McpOverlapConfidence,
  McpOverlapGroup,
  McpOverlapKind,
  McpServerEntry,
} from '../api/types.js';

const DASH = '\u2014';

const KIND_LABELS: Record<McpOverlapKind, string> = {
  'same-target': 'Same launch command',
  'same-package': 'Same package',
  'same-endpoint': 'Same endpoint',
  'same-host': 'Same host',
  'shared-domain': 'Same capability area',
};

const CONFIDENCE_VARIANTS: Record<McpOverlapConfidence, BadgeVariant> = {
  high: 'warning',
  medium: 'info',
  low: 'neutral',
};

/** A single file a server can be removed from. */
interface RemovalTarget {
  fileId: string;
  displayPath: string;
  providerName: string;
}

interface Notice {
  kind: 'ok' | 'error';
  message: string;
}

/** DOM-safe id fragment, since server names may contain spaces or dots. */
function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '-');
}

function serverStatus(server: McpServerEntry): { variant: BadgeVariant; label: string } {
  if (server.conflicting) return { variant: 'conflict', label: 'Conflict' };
  if (server.duplicated) return { variant: 'duplicate', label: 'Duplicate' };
  if (server.definitions.every((definition) => definition.disabled)) {
    return { variant: 'disabled', label: 'Disabled' };
  }
  return { variant: 'ok', label: 'OK' };
}

function summarizeTransport(definitions: readonly McpDefinition[]): string {
  const transports = new Set(definitions.map((definition) => definition.transport));
  return transports.size === 1 ? [...transports][0]! : 'mixed';
}

function summarizeTarget(definition: McpDefinition | undefined): string {
  if (!definition) return DASH;
  return definition.command ?? definition.url ?? definition.reference ?? DASH;
}

/**
 * One entry per file, not per declaration.
 *
 * A single file can declare the same server twice — `~/.claude.json` carries a
 * global map and per-project ones — and a removal takes out every occurrence
 * in the file it touches, so listing the file twice would offer a no-op.
 */
function removalTargets(server: McpServerEntry): RemovalTarget[] {
  const byFile = new Map<string, RemovalTarget>();
  for (const definition of server.definitions) {
    if (byFile.has(definition.fileId)) continue;
    byFile.set(definition.fileId, {
      fileId: definition.fileId,
      displayPath: definition.displayPath,
      providerName: definition.providerName,
    });
  }
  return [...byFile.values()];
}

export function McpView(): ReactElement {
  const state = useAsync(async () => {
    const [inventory, health] = await Promise.all([getInventory(), getHealth()]);
    return { inventory, health };
  }, []);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);

  const { reload } = state;

  const remove = useCallback(
    async (serverName: string, targets: readonly RemovalTarget[]): Promise<void> => {
      setBusy(serverName);
      setNotice(undefined);

      const removed: string[] = [];
      const failures: string[] = [];
      for (const target of targets) {
        try {
          const outcome = await deleteMcpServer(target.fileId, serverName);
          if (outcome.ok) removed.push(`${target.displayPath} (backup: ${outcome.backupPath})`);
          else failures.push(`${target.displayPath}: ${outcome.message}`);
        } catch (caught) {
          failures.push(
            `${target.displayPath}: ${caught instanceof Error ? caught.message : String(caught)}`,
          );
        }
      }

      setBusy(undefined);
      setConfirming(undefined);
      setNotice(
        failures.length === 0
          ? {
              kind: 'ok',
              message: `Removed "${serverName}" from ${removed.length} file${
                removed.length === 1 ? '' : 's'
              }: ${removed.join('; ')}`,
            }
          : {
              kind: 'error',
              message:
                (removed.length > 0
                  ? `Removed "${serverName}" from ${removed.length} file(s): ${removed.join('; ')}. `
                  : `"${serverName}" was not removed. `) + failures.join(' '),
            },
      );

      reload();
    },
    [reload],
  );

  if (state.loading) return <LoadingState label="Loading MCP servers…" />;
  if (state.error) {
    return (
      <ErrorState message={state.error} {...(state.retryable ? { onRetry: state.reload } : {})} />
    );
  }
  if (!state.data) return <EmptyState title="No data available." />;

  const { inventory, health } = state.data;
  const servers = inventory.mcpServers;
  const overlaps = inventory.mcpOverlaps;

  if (servers.length === 0) {
    return (
      <div className="view view-mcp">
        <h2>MCP servers</h2>
        <EmptyState
          title="No MCP servers were found."
          detail="Configure an MCP server in any supported tool and rescan."
        />
      </div>
    );
  }

  const toggle = (name: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  // Reverse index so each row can link to the groups it participates in.
  const overlapsByServer = new Map<string, { group: McpOverlapGroup; index: number }[]>();
  overlaps.forEach((group, index) => {
    for (const name of group.serverNames) {
      const bucket = overlapsByServer.get(name);
      if (bucket) bucket.push({ group, index });
      else overlapsByServer.set(name, [{ group, index }]);
    }
  });

  return (
    <div className="view view-mcp">
      <h2>MCP servers</h2>
      <p className="muted">
        {servers.length} distinct server name(s) across every configured tool.{' '}
        {servers.filter((server) => server.duplicated).length} declared in more than one place,{' '}
        {servers.filter((server) => server.conflicting).length} with conflicting settings,{' '}
        {overlaps.length} group(s) of differently named servers that look like they overlap. Each
        expanded row shows the tool, location, directory, and file every definition comes from.
      </p>

      {notice ? (
        <div
          className={notice.kind === 'ok' ? 'notice notice-ok' : 'notice notice-error'}
          role={notice.kind === 'ok' ? 'status' : 'alert'}
          aria-live="polite"
        >
          <p>{notice.message}</p>
          <div className="notice-actions">
            <button type="button" onClick={() => setNotice(undefined)}>
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      <OverlapPanel groups={overlaps} />

      <table className="mcp-table">
        <caption className="visually-hidden">MCP servers by name, status, and source</caption>
        <thead>
          <tr>
            <th scope="col" aria-hidden="true"></th>
            <th scope="col">Name</th>
            <th scope="col">Status</th>
            <th scope="col">Overlaps</th>
            <th scope="col">Transport</th>
            <th scope="col">Defined by</th>
            <th scope="col">Directories</th>
            <th scope="col">Command / URL</th>
            <th scope="col">Env vars</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {servers.map((server) => (
            <ServerRow
              key={server.name}
              server={server}
              status={serverStatus(server)}
              isOpen={expanded.has(server.name)}
              onToggle={() => toggle(server.name)}
              overlaps={overlapsByServer.get(server.name) ?? []}
              readOnly={health.readOnly}
              confirming={confirming === server.name}
              busy={busy === server.name}
              onRequestRemove={() => {
                setNotice(undefined);
                setConfirming(server.name);
              }}
              onCancelRemove={() => setConfirming(undefined)}
              onRemove={(targets) => void remove(server.name, targets)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------- Overlaps -- */

function OverlapPanel({ groups }: { groups: readonly McpOverlapGroup[] }): ReactElement {
  if (groups.length === 0) {
    return (
      <section className="mcp-overlaps" aria-labelledby="mcp-overlaps-heading">
        <h3 id="mcp-overlaps-heading">Overlapping servers</h3>
        <EmptyState
          title="No overlap detected."
          detail="No two differently named servers share a launch command, package, endpoint, or capability area."
        />
      </section>
    );
  }

  return (
    <section className="mcp-overlaps" aria-labelledby="mcp-overlaps-heading">
      <h3 id="mcp-overlaps-heading">Overlapping servers</h3>
      <p className="muted">
        Servers with different names that look like they do the same job. Every registered server
        spends context window on its tool definitions whether or not the model uses them, so
        redundant ones are worth pruning. Overlap is inferred from launch commands, packages,
        endpoints, and naming — never by contacting a server — so the evidence is shown for each
        group.
      </p>
      <ul className="overlap-list">
        {groups.map((group, index) => (
          <li
            key={group.id}
            id={`overlap-${index}`}
            className={`overlap-card overlap-${group.confidence}`}
          >
            <div className="overlap-head">
              <Badge variant={CONFIDENCE_VARIANTS[group.confidence]}>
                {KIND_LABELS[group.kind]}
              </Badge>
              <span className="chip chip-quiet">{group.confidence} confidence</span>
              <h4>{group.title}</h4>
            </div>
            <p className="overlap-detail">{group.detail}</p>
            <table className="overlap-members">
              <caption className="visually-hidden">Servers in this overlap group</caption>
              <thead>
                <tr>
                  <th scope="col">Server</th>
                  <th scope="col">Evidence</th>
                  <th scope="col">Defined by</th>
                  <th scope="col">Files</th>
                </tr>
              </thead>
              <tbody>
                {group.members.map((member) => (
                  <tr key={member.serverName}>
                    <th scope="row">
                      {member.serverName}{' '}
                      {member.disabled ? <Badge variant="disabled">Disabled</Badge> : null}
                    </th>
                    <td className="mcp-target">{member.evidence}</td>
                    <td>{member.providerNames.join(', ')}</td>
                    <td>
                      <ul className="plain-list">
                        {member.fileIds.map((fileId, position) => (
                          <li key={fileId}>
                            <a href={`#/files/${encodeURIComponent(fileId)}`}>
                              <code>{member.displayPaths[position] ?? fileId}</code>
                            </a>
                          </li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="finding-remediation">{group.remediation}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ---------------------------------------------------------------- Table -- */

function ServerRow({
  server,
  status,
  isOpen,
  onToggle,
  overlaps,
  readOnly,
  confirming,
  busy,
  onRequestRemove,
  onCancelRemove,
  onRemove,
}: {
  server: McpServerEntry;
  status: { variant: BadgeVariant; label: string };
  isOpen: boolean;
  onToggle: () => void;
  overlaps: readonly { group: McpOverlapGroup; index: number }[];
  readOnly: boolean;
  confirming: boolean;
  busy: boolean;
  onRequestRemove: () => void;
  onCancelRemove: () => void;
  onRemove: (targets: readonly RemovalTarget[]) => void;
}): ReactElement {
  const id = slug(server.name);
  const providerNames = [...new Set(server.definitions.map((d) => d.providerName))];
  const envKeys = [...new Set(server.definitions.flatMap((d) => d.envKeys))];

  return (
    <>
      <tr className={server.conflicting ? 'mcp-row mcp-row-conflict' : 'mcp-row'}>
        <td>
          <button
            type="button"
            className="tree-toggle"
            aria-expanded={isOpen}
            aria-controls={`mcp-defs-${id}`}
            onClick={onToggle}
          >
            <span aria-hidden="true">{isOpen ? '\u25BE' : '\u25B8'}</span>
            <span className="visually-hidden">Toggle definitions for {server.name}</span>
          </button>
        </td>
        <th scope="row">{server.name}</th>
        <td>
          <Badge variant={status.variant}>{status.label}</Badge>
        </td>
        <td>
          {overlaps.length === 0 ? (
            <span className="muted">{DASH}</span>
          ) : (
            <ul className="chip-list inline">
              {overlaps.map(({ group, index }) => (
                <li key={group.id}>
                  <a className="chip chip-quiet" href={`#overlap-${index}`}>
                    {KIND_LABELS[group.kind]}
                    <span className="visually-hidden">
                      {' '}
                      as {group.serverNames.filter((name) => name !== server.name).join(', ')}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </td>
        <td>{summarizeTransport(server.definitions)}</td>
        <td>
          <ul className="chip-list inline">
            {providerNames.map((name) => (
              <li key={name}>
                <span className="chip">{name}</span>
              </li>
            ))}
          </ul>
        </td>
        <td className="mcp-directories">
          <ul>
            {server.directories.map((directory) => (
              <li key={directory}>
                <code>{directory}</code>
              </li>
            ))}
          </ul>
        </td>
        <td className="mcp-target">{summarizeTarget(server.definitions[0])}</td>
        <td>{envKeys.length > 0 ? envKeys.join(', ') : DASH}</td>
        <td>
          {readOnly ? (
            <span className="muted">Read-only</span>
          ) : (
            <button
              type="button"
              className="danger"
              onClick={onRequestRemove}
              disabled={confirming || busy}
              aria-expanded={confirming}
              aria-controls={`mcp-remove-${id}`}
            >
              Remove…
            </button>
          )}
        </td>
      </tr>

      {confirming ? (
        <tr id={`mcp-remove-${id}`} className="mcp-remove-row">
          <td></td>
          <td colSpan={9}>
            <RemoveConfirm
              serverName={server.name}
              targets={removalTargets(server)}
              busy={busy}
              onConfirm={onRemove}
              onCancel={onCancelRemove}
            />
          </td>
        </tr>
      ) : null}

      {isOpen ? (
        <tr id={`mcp-defs-${id}`}>
          <td></td>
          <td colSpan={9}>
            <table className="mcp-definitions-table">
              <caption className="visually-hidden">Every definition of {server.name}</caption>
              <thead>
                <tr>
                  <th scope="col">Tool</th>
                  <th scope="col">Location</th>
                  <th scope="col">Scope</th>
                  <th scope="col">Directory</th>
                  <th scope="col">File</th>
                  <th scope="col">Transport</th>
                  <th scope="col">Command / URL / reference</th>
                  <th scope="col">Env vars</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {server.definitions.map((definition, index) => (
                  <tr key={`${definition.fileId}-${index}`}>
                    <td>{definition.providerName}</td>
                    <td>{definition.locationLabel}</td>
                    <td>{SCOPE_LABELS[definition.scope]}</td>
                    <td className="mcp-directory">
                      <code title={definition.displayPath}>{definition.directory}</code>
                    </td>
                    <td>
                      <a href={`#/files/${encodeURIComponent(definition.fileId)}`}>
                        {definition.fileName}
                      </a>
                    </td>
                    <td>{definition.transport}</td>
                    <td className="mcp-target">
                      {definition.command ?? definition.url ?? definition.reference ?? DASH}
                    </td>
                    <td>{definition.envKeys.length > 0 ? definition.envKeys.join(', ') : DASH}</td>
                    <td>
                      {definition.disabled ? (
                        <Badge variant="disabled">Disabled</Badge>
                      ) : (
                        <Badge variant="ok">Active</Badge>
                      )}
                      {definition.hasInlineSecret ? (
                        <Badge variant="warning">Inline secret</Badge>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      ) : null}
    </>
  );
}

/**
 * Confirmation step for a destructive, potentially cross-file edit.
 *
 * The affected files are spelled out rather than counted because "remove this
 * server" can mean touching four files owned by four different tools, and the
 * user has to see that before agreeing to it.
 */
function RemoveConfirm({
  serverName,
  targets,
  busy,
  onConfirm,
  onCancel,
}: {
  serverName: string;
  targets: readonly RemovalTarget[];
  busy: boolean;
  onConfirm: (targets: readonly RemovalTarget[]) => void;
  onCancel: () => void;
}): ReactElement {
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Moving focus is the only way a screen reader user learns the step exists.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const headingId = `mcp-remove-heading-${slug(serverName)}`;

  return (
    <section className="mcp-remove-confirm" aria-labelledby={headingId}>
      <h4 id={headingId} ref={headingRef} tabIndex={-1}>
        Remove “{serverName}”?
      </h4>
      <p>
        This deletes the declaration from {targets.length} file
        {targets.length === 1 ? '' : 's'}. A timestamped backup is written to{' '}
        <code>~/.ai-harness-helper/backups</code> before each change, and comments and formatting
        elsewhere in the file are preserved. Any credentials the server used are left wherever they
        already live.
      </p>
      <ul className="plain-list">
        {targets.map((target) => (
          <li key={target.fileId}>
            <code>{target.displayPath}</code> <span className="muted">({target.providerName})</span>
            {targets.length > 1 ? (
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() => onConfirm([target])}
              >
                Remove from this file only
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="notice-actions">
        <button type="button" className="danger" disabled={busy} onClick={() => onConfirm(targets)}>
          {busy
            ? 'Removing…'
            : targets.length === 1
              ? 'Remove from this file'
              : `Remove from all ${targets.length} files`}
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}
