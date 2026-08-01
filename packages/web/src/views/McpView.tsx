/**
 * Unified view of every MCP server declared anywhere in the harness, with
 * duplicates and conflicts called out explicitly.
 */

import { useState } from 'react';
import type { ReactElement } from 'react';
import { getInventory } from '../api/client.js';
import { Badge } from '../components/Badge.js';
import { EmptyState, ErrorState, LoadingState } from '../components/StatusStates.js';
import { useAsync } from '../hooks/useAsync.js';
import { SCOPE_LABELS } from '../lib/scope.js';
import type { BadgeVariant } from '../components/Badge.js';
import type { McpDefinition, McpServerEntry } from '../api/types.js';

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
  if (!definition) return '\u2014';
  return definition.command ?? definition.url ?? definition.reference ?? '\u2014';
}

export function McpView(): ReactElement {
  const inventory = useAsync(getInventory, []);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  if (inventory.loading) return <LoadingState label="Loading MCP servers…" />;
  if (inventory.error) {
    return (
      <ErrorState
        message={inventory.error}
        {...(inventory.retryable ? { onRetry: inventory.reload } : {})}
      />
    );
  }
  if (!inventory.data) return <EmptyState title="No data available." />;

  const servers = inventory.data.mcpServers;
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

  return (
    <div className="view view-mcp">
      <h2>MCP servers</h2>
      <p className="muted">
        {servers.length} distinct server name(s) across every configured tool.
      </p>
      <table className="mcp-table">
        <caption className="visually-hidden">MCP servers by name, status, and source</caption>
        <thead>
          <tr>
            <th scope="col" aria-hidden="true"></th>
            <th scope="col">Name</th>
            <th scope="col">Status</th>
            <th scope="col">Transport</th>
            <th scope="col">Defined by</th>
            <th scope="col">Command / URL</th>
            <th scope="col">Env vars</th>
          </tr>
        </thead>
        <tbody>
          {servers.map((server) => {
            const status = serverStatus(server);
            const isOpen = expanded.has(server.name);
            const providerNames = [
              ...new Set(server.definitions.map((definition) => definition.providerName)),
            ];
            const envKeys = [
              ...new Set(server.definitions.flatMap((definition) => definition.envKeys)),
            ];
            return (
              <FragmentRow
                key={server.name}
                server={server}
                status={status}
                isOpen={isOpen}
                onToggle={() => toggle(server.name)}
                providerNames={providerNames}
                envKeys={envKeys}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FragmentRow({
  server,
  status,
  isOpen,
  onToggle,
  providerNames,
  envKeys,
}: {
  server: McpServerEntry;
  status: { variant: BadgeVariant; label: string };
  isOpen: boolean;
  onToggle: () => void;
  providerNames: string[];
  envKeys: string[];
}): ReactElement {
  return (
    <>
      <tr className={server.conflicting ? 'mcp-row mcp-row-conflict' : 'mcp-row'}>
        <td>
          <button
            type="button"
            className="tree-toggle"
            aria-expanded={isOpen}
            aria-controls={`mcp-defs-${server.name}`}
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
        <td className="mcp-target">{summarizeTarget(server.definitions[0])}</td>
        <td>{envKeys.length > 0 ? envKeys.join(', ') : '\u2014'}</td>
      </tr>
      {isOpen ? (
        <tr id={`mcp-defs-${server.name}`}>
          <td></td>
          <td colSpan={6}>
            <table className="mcp-definitions-table">
              <caption className="visually-hidden">Every definition of {server.name}</caption>
              <thead>
                <tr>
                  <th scope="col">Source</th>
                  <th scope="col">Scope</th>
                  <th scope="col">Transport</th>
                  <th scope="col">Command / URL / reference</th>
                  <th scope="col">Env vars</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {server.definitions.map((definition) => (
                  <tr key={definition.fileId}>
                    <td>
                      <a href={`#/files/${encodeURIComponent(definition.fileId)}`}>
                        {definition.displayPath}
                      </a>
                    </td>
                    <td>{SCOPE_LABELS[definition.scope]}</td>
                    <td>{definition.transport}</td>
                    <td className="mcp-target">
                      {definition.command ?? definition.url ?? definition.reference ?? '\u2014'}
                    </td>
                    <td>
                      {definition.envKeys.length > 0 ? definition.envKeys.join(', ') : '\u2014'}
                    </td>
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
