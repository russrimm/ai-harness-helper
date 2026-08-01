/**
 * Rollup of instructions, capabilities, and guardrails across every tool —
 * the "policy" half of the harness, as opposed to the raw file listing.
 *
 * Every row carries its full provenance (tool, location, directory, file) and
 * a duplicate badge, because the question this view exists to answer is
 * "which of these is actually in effect, and where did it come from?".
 */

import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { getInventory } from '../api/client.js';
import { Badge, scopeVariant } from '../components/Badge.js';
import {
  DuplicateBadge,
  DuplicateSiblings,
  Provenance,
  isDuplicated,
} from '../components/Provenance.js';
import { EmptyState, ErrorState, LoadingState } from '../components/StatusStates.js';
import { useAsync } from '../hooks/useAsync.js';
import { SCOPE_LABELS } from '../lib/scope.js';
import type {
  CapabilityEntry,
  CapabilityKind,
  ConfigScope,
  DuplicateInfo,
  GuardrailEntry,
  InstructionEntry,
} from '../api/types.js';

const CAPABILITY_KIND_LABELS: Record<CapabilityKind, string> = {
  agent: 'Agents',
  skill: 'Skills',
  prompt: 'Prompts',
  command: 'Commands',
  chatmode: 'Chat modes',
};

const CAPABILITY_KIND_ORDER: CapabilityKind[] = ['agent', 'skill', 'command', 'prompt', 'chatmode'];

interface Filters {
  text: string;
  scope: ConfigScope | 'all';
  duplicatesOnly: boolean;
}

const NO_FILTERS: Filters = { text: '', scope: 'all', duplicatesOnly: false };

interface FilterableEntry {
  scope: ConfigScope;
  providerName: string;
  directory: string;
  displayPath: string;
  fileName: string;
  locationLabel: string;
  duplicate: DuplicateInfo;
}

/**
 * Shared predicate so instructions, capabilities, and guardrails all respond
 * to the same controls. Matching includes the directory and provider on
 * purpose: "show me everything under ~/.claude" is a real question.
 */
function keep(entry: FilterableEntry, label: string, filters: Filters): boolean {
  if (filters.scope !== 'all' && entry.scope !== filters.scope) return false;
  if (filters.duplicatesOnly && !isDuplicated(entry.duplicate)) return false;
  const needle = filters.text.trim().toLowerCase();
  if (needle.length === 0) return true;
  return [
    label,
    entry.providerName,
    entry.directory,
    entry.displayPath,
    entry.fileName,
    entry.locationLabel,
  ].some((value) => value.toLowerCase().includes(needle));
}

export function InstructionsView(): ReactElement {
  const inventory = useAsync(getInventory, []);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);

  const data = inventory.data;
  const instructions = useMemo(
    () =>
      [...(data?.instructions ?? [])]
        .filter((entry) => keep(entry, entry.title, filters))
        .sort((a, b) => b.precedence - a.precedence),
    [data, filters],
  );
  const capabilities = useMemo(
    () => (data?.capabilities ?? []).filter((entry) => keep(entry, entry.name, filters)),
    [data, filters],
  );
  const guardrails = useMemo(
    () => (data?.guardrails ?? []).filter((entry) => keep(entry, entry.kind, filters)),
    [data, filters],
  );

  if (inventory.loading) return <LoadingState label="Loading instructions…" />;
  if (inventory.error) {
    return (
      <ErrorState
        message={inventory.error}
        {...(inventory.retryable ? { onRetry: inventory.reload } : {})}
      />
    );
  }
  if (!data) return <EmptyState title="No data available." />;

  const total = data.instructions.length + data.capabilities.length + data.guardrails.length;
  const shown = instructions.length + capabilities.length + guardrails.length;
  const duplicates = [...data.instructions, ...data.capabilities, ...data.guardrails].filter(
    (entry) => isDuplicated(entry.duplicate),
  ).length;

  return (
    <div className="view view-instructions">
      <div className="view-header">
        <h2>Instructions, capabilities &amp; guardrails</h2>
      </div>
      <p className="muted">
        {shown} of {total} entries shown. {duplicates} declared in more than one place. Every entry
        shows the tool, location, directory, and file it comes from — follow the file link to edit
        it.
      </p>

      <div className="toolbar">
        <label htmlFor="policy-filter">Filter by name, tool, or folder</label>
        <input
          id="policy-filter"
          type="search"
          value={filters.text}
          placeholder="AGENTS.md, ~/.codex, reviewer"
          onChange={(event) => setFilters((prev) => ({ ...prev, text: event.target.value }))}
        />
        <label htmlFor="policy-scope">Scope</label>
        <select
          id="policy-scope"
          value={filters.scope}
          onChange={(event) =>
            setFilters((prev) => ({ ...prev, scope: event.target.value as Filters['scope'] }))
          }
        >
          <option value="all">All scopes</option>
          <option value="project">Project</option>
          <option value="user">User</option>
          <option value="managed">Managed</option>
        </select>
        <label className="toolbar-check">
          <input
            type="checkbox"
            checked={filters.duplicatesOnly}
            onChange={(event) =>
              setFilters((prev) => ({ ...prev, duplicatesOnly: event.target.checked }))
            }
          />
          Duplicates only
        </label>
      </div>

      <section aria-labelledby="instructions-heading">
        <h3 id="instructions-heading">Instructions ({instructions.length})</h3>
        {instructions.length === 0 ? (
          <EmptyState title="No instruction files match." />
        ) : (
          <ol className="instruction-list">
            {instructions.map((entry) => (
              <InstructionRow key={entry.fileId} entry={entry} />
            ))}
          </ol>
        )}
      </section>

      <section aria-labelledby="capabilities-heading">
        <h3 id="capabilities-heading">Capabilities ({capabilities.length})</h3>
        {capabilities.length === 0 ? (
          <EmptyState title="No agents, skills, prompts, commands, or chat modes match." />
        ) : (
          <CapabilityRollup capabilities={capabilities} />
        )}
      </section>

      <section aria-labelledby="guardrails-heading">
        <h3 id="guardrails-heading">Guardrails ({guardrails.length})</h3>
        {guardrails.length === 0 ? (
          <EmptyState title="No permission, ignore, or hook configuration matches." />
        ) : (
          <ul className="guardrail-list">
            {guardrails.map((entry) => (
              <GuardrailCard key={entry.fileId} entry={entry} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function InstructionRow({ entry }: { entry: InstructionEntry }): ReactElement {
  return (
    <li className={entry.duplicate.conflicting ? 'instruction-row is-conflict' : 'instruction-row'}>
      <div className="instruction-row-header">
        <Badge variant={scopeVariant(entry.scope)}>{SCOPE_LABELS[entry.scope]} precedence</Badge>
        <a href={`#/files/${encodeURIComponent(entry.fileId)}`} className="instruction-title">
          {entry.title}
        </a>
        <DuplicateBadge info={entry.duplicate} />
      </div>
      {entry.description ? <p className="instruction-description">{entry.description}</p> : null}
      <Provenance entry={entry} showScope={false} />
      <p className="muted small">
        {entry.lineCount} line(s) &middot; {entry.bytes} bytes
        {entry.appliesTo ? (
          <>
            {' '}
            &middot; applies to <code>{entry.appliesTo}</code>
          </>
        ) : null}
      </p>
      <DuplicateSiblings info={entry.duplicate} />
    </li>
  );
}

function CapabilityRollup({ capabilities }: { capabilities: CapabilityEntry[] }): ReactElement {
  const groups = new Map<CapabilityKind, CapabilityEntry[]>();
  for (const capability of capabilities) {
    const list = groups.get(capability.kind);
    if (list) list.push(capability);
    else groups.set(capability.kind, [capability]);
  }

  return (
    <div className="capability-groups">
      {CAPABILITY_KIND_ORDER.filter((kind) => (groups.get(kind)?.length ?? 0) > 0).map((kind) => (
        <div className="capability-group" key={kind}>
          <h4>
            {CAPABILITY_KIND_LABELS[kind]}{' '}
            <span className="muted">({groups.get(kind)?.length ?? 0})</span>
          </h4>
          <ul className="capability-list">
            {(groups.get(kind) ?? []).map((capability) => (
              <li
                className={
                  capability.duplicate.conflicting
                    ? 'capability-card is-conflict'
                    : 'capability-card'
                }
                key={capability.fileId}
              >
                <div className="capability-card-header">
                  <a href={`#/files/${encodeURIComponent(capability.fileId)}`}>{capability.name}</a>
                  <DuplicateBadge info={capability.duplicate} />
                </div>
                {capability.description ? <p>{capability.description}</p> : null}
                <Provenance entry={capability} />
                {capability.model || (capability.tools && capability.tools.length > 0) ? (
                  <p className="muted small">
                    {capability.model ? <>Model: {capability.model}</> : null}
                    {capability.model && capability.tools && capability.tools.length > 0
                      ? ' \u00B7 '
                      : null}
                    {capability.tools && capability.tools.length > 0 ? (
                      <>Tools: {capability.tools.join(', ')}</>
                    ) : null}
                  </p>
                ) : null}
                <DuplicateSiblings info={capability.duplicate} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function GuardrailCard({ entry }: { entry: GuardrailEntry }): ReactElement {
  return (
    <li className={entry.duplicate.conflicting ? 'guardrail-card is-conflict' : 'guardrail-card'}>
      <div className="guardrail-card-header">
        <a href={`#/files/${encodeURIComponent(entry.fileId)}`}>{entry.fileName}</a>
        <span className="chip">{entry.kind}</span>
        <DuplicateBadge info={entry.duplicate} />
      </div>
      <Provenance entry={entry} />
      <div className="guardrail-rules">
        <RuleList label="Allow" rules={entry.allow} tone="ok" />
        <RuleList label="Deny" rules={entry.deny} tone="error" />
        <RuleList label="Ask" rules={entry.ask} tone="warning" />
        <RuleList label="Hooks" rules={entry.hooks} tone="neutral" />
        <RuleList label="Ignore patterns" rules={entry.ignorePatterns} tone="neutral" />
      </div>
      <DuplicateSiblings info={entry.duplicate} />
    </li>
  );
}

function RuleList({
  label,
  rules,
  tone,
}: {
  label: string;
  rules: string[];
  tone: 'ok' | 'error' | 'warning' | 'neutral';
}): ReactElement | null {
  if (rules.length === 0) return null;
  return (
    <div className={`rule-list rule-list-${tone}`}>
      <h5>{label}</h5>
      <ul>
        {rules.map((rule, index) => (
          <li key={`${rule}-${index}`}>
            <code>{rule}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}
