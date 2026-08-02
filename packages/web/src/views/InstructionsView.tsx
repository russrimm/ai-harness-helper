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
import { getHealth, getInventory } from '../api/client.js';
import { Badge, scopeVariant } from '../components/Badge.js';
import { DeleteButton, DeleteConfirm, DeleteNoticeBanner } from '../components/DeleteControl.js';
import {
  DuplicateBadge,
  DuplicateSiblings,
  Provenance,
  isDuplicated,
} from '../components/Provenance.js';
import { EmptyState, ErrorState, LoadingState } from '../components/StatusStates.js';
import { useAsync } from '../hooks/useAsync.js';
import { useFileDeletion, type FileDeletion } from '../hooks/useFileDeletion.js';
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

/** Singular nouns, so a confirmation reads "Delete skill “pdf”?". */
const CAPABILITY_NOUNS: Record<CapabilityKind, string> = {
  agent: 'agent',
  skill: 'skill',
  prompt: 'prompt',
  command: 'command',
  chatmode: 'chat mode',
};

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
  const state = useAsync(async () => {
    const [inventory, health] = await Promise.all([getInventory(), getHealth()]);
    return { inventory, health };
  }, []);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);

  const { reload } = state;
  const deletion = useFileDeletion(reload);

  const data = state.data?.inventory;
  const readOnly = state.data?.health.readOnly ?? true;
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

  if (state.loading) return <LoadingState label="Loading instructions…" />;
  if (state.error) {
    return (
      <ErrorState message={state.error} {...(state.retryable ? { onRetry: state.reload } : {})} />
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
        it, or use the delete button to remove the file that declares it.
      </p>

      <DeleteNoticeBanner notice={deletion.notice} onDismiss={deletion.dismissNotice} />

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
              <InstructionRow
                key={entry.fileId}
                entry={entry}
                deletion={deletion}
                readOnly={readOnly}
              />
            ))}
          </ol>
        )}
      </section>

      <section aria-labelledby="capabilities-heading">
        <h3 id="capabilities-heading">Capabilities ({capabilities.length})</h3>
        {capabilities.length === 0 ? (
          <EmptyState title="No agents, skills, prompts, commands, or chat modes match." />
        ) : (
          <CapabilityRollup capabilities={capabilities} deletion={deletion} readOnly={readOnly} />
        )}
      </section>

      <section aria-labelledby="guardrails-heading">
        <h3 id="guardrails-heading">Guardrails ({guardrails.length})</h3>
        {guardrails.length === 0 ? (
          <EmptyState title="No permission, ignore, or hook configuration matches." />
        ) : (
          <ul className="guardrail-list">
            {guardrails.map((entry) => (
              <GuardrailCard
                key={entry.fileId}
                entry={entry}
                deletion={deletion}
                readOnly={readOnly}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function InstructionRow({
  entry,
  deletion,
  readOnly,
}: {
  entry: InstructionEntry;
  deletion: FileDeletion;
  readOnly: boolean;
}): ReactElement {
  return (
    <li className={entry.duplicate.conflicting ? 'instruction-row is-conflict' : 'instruction-row'}>
      <div className="instruction-row-header">
        <Badge variant={scopeVariant(entry.scope)}>{SCOPE_LABELS[entry.scope]} precedence</Badge>
        <a href={`#/files/${encodeURIComponent(entry.fileId)}`} className="instruction-title">
          {entry.title}
        </a>
        <DuplicateBadge info={entry.duplicate} />
        <EntryDelete
          entry={entry}
          label={entry.title}
          noun="instruction file"
          deletion={deletion}
          readOnly={readOnly}
        />
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
      <EntryDeleteConfirm
        entry={entry}
        label={entry.title}
        noun="instruction file"
        deletion={deletion}
      />
    </li>
  );
}

/**
 * The provenance fields the delete controls need, which is every entry type in
 * this view — instructions, capabilities, and guardrails all carry them.
 */
interface DeletableEntry {
  fileId: string;
  displayPath: string;
  deletable: boolean;
  notDeletableReason?: string;
}

function confirmId(fileId: string): string {
  return `delete-${encodeURIComponent(fileId).replace(/%/g, '-')}`;
}

/**
 * The delete trigger for one row.
 *
 * Renders nothing at all in a read-only session rather than a disabled button
 * on every row, because `--read-only` is a property of the whole run and
 * repeating it forty times is noise.
 */
function EntryDelete({
  entry,
  label,
  noun,
  deletion,
  readOnly,
}: {
  entry: DeletableEntry;
  label: string;
  noun: string;
  deletion: FileDeletion;
  readOnly: boolean;
}): ReactElement | null {
  if (readOnly) return null;
  return (
    <DeleteButton
      target={{ label, noun, displayPath: entry.displayPath }}
      deletable={entry.deletable}
      reason={entry.notDeletableReason}
      expanded={deletion.confirmingId === entry.fileId}
      busy={deletion.busyId !== undefined}
      controls={confirmId(entry.fileId)}
      onClick={() => deletion.request(entry.fileId)}
    />
  );
}

function EntryDeleteConfirm({
  entry,
  label,
  noun,
  deletion,
}: {
  entry: DeletableEntry;
  label: string;
  noun: string;
  deletion: FileDeletion;
}): ReactElement | null {
  if (deletion.confirmingId !== entry.fileId) return null;
  return (
    <DeleteConfirm
      id={confirmId(entry.fileId)}
      target={{ label, noun, displayPath: entry.displayPath }}
      busy={deletion.busyId === entry.fileId}
      onConfirm={() => deletion.confirm(entry.fileId, label)}
      onCancel={deletion.cancel}
    />
  );
}

function CapabilityRollup({
  capabilities,
  deletion,
  readOnly,
}: {
  capabilities: CapabilityEntry[];
  deletion: FileDeletion;
  readOnly: boolean;
}): ReactElement {
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
                  <EntryDelete
                    entry={capability}
                    label={capability.name}
                    noun={CAPABILITY_NOUNS[capability.kind]}
                    deletion={deletion}
                    readOnly={readOnly}
                  />
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
                <EntryDeleteConfirm
                  entry={capability}
                  label={capability.name}
                  noun={CAPABILITY_NOUNS[capability.kind]}
                  deletion={deletion}
                />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function GuardrailCard({
  entry,
  deletion,
  readOnly,
}: {
  entry: GuardrailEntry;
  deletion: FileDeletion;
  readOnly: boolean;
}): ReactElement {
  return (
    <li className={entry.duplicate.conflicting ? 'guardrail-card is-conflict' : 'guardrail-card'}>
      <div className="guardrail-card-header">
        <a href={`#/files/${encodeURIComponent(entry.fileId)}`}>{entry.fileName}</a>
        <span className="chip">{entry.kind}</span>
        <DuplicateBadge info={entry.duplicate} />
        <EntryDelete
          entry={entry}
          label={entry.fileName}
          noun="guardrail file"
          deletion={deletion}
          readOnly={readOnly}
        />
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
      <EntryDeleteConfirm
        entry={entry}
        label={entry.fileName}
        noun="guardrail file"
        deletion={deletion}
      />
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
